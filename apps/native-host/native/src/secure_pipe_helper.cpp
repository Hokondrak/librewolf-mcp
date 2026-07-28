#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <aclapi.h>
#include <bcrypt.h>
#include <sddl.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cwchar>
#include <iterator>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr DWORD kMaximumFrameBytes = 8U * 1024U * 1024U;
constexpr DWORD kMaximumDiscoveryBytes = 64U * 1024U;
constexpr DWORD kPipeBufferBytes = 64U * 1024U;
constexpr DWORD kPipeAccessMask =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE;
constexpr DWORD kFileAccessMask =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE | DELETE;
constexpr DWORD kDirectoryAccessMask =
    kFileAccessMask | FILE_DELETE_CHILD;
constexpr std::wstring_view kPipePrefix = L"\\\\.\\pipe\\librewolf-agent-bridge\\";
constexpr std::array<std::uint8_t, 16> kTransportPreface = {
    'L', 'W', 'B', 'P', 'I', 'P', 'E', '1',
    0x03, 0x00, 0x00, 0x00,  // current-user DACL and remote-client rejection
    0x01, 0x00, 0x00, 0x00,  // native transport protocol version 1
};

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE handle) : handle_(handle) {}
  ~UniqueHandle() { reset(); }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept : handle_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      reset(other.release());
    }
    return *this;
  }

  [[nodiscard]] HANDLE get() const { return handle_; }
  [[nodiscard]] bool valid() const {
    return handle_ != nullptr && handle_ != INVALID_HANDLE_VALUE;
  }
  HANDLE release() {
    HANDLE value = handle_;
    handle_ = INVALID_HANDLE_VALUE;
    return value;
  }
  void reset(HANDLE next = INVALID_HANDLE_VALUE) {
    if (valid()) {
      CloseHandle(handle_);
    }
    handle_ = next;
  }

 private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
};

class LocalAllocation {
 public:
  LocalAllocation() = default;
  explicit LocalAllocation(void* value) : value_(value) {}
  ~LocalAllocation() {
    if (value_ != nullptr) {
      LocalFree(value_);
    }
  }

  LocalAllocation(const LocalAllocation&) = delete;
  LocalAllocation& operator=(const LocalAllocation&) = delete;

  [[nodiscard]] void* get() const { return value_; }
  void reset(void* next = nullptr) {
    if (value_ != nullptr) {
      LocalFree(value_);
    }
    value_ = next;
  }

 private:
  void* value_ = nullptr;
};

std::string Utf8(std::wstring_view value) {
  if (value.empty()) {
    return {};
  }
  const int required = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      nullptr, 0, nullptr, nullptr);
  if (required <= 0) {
    return "<invalid utf-16>";
  }
  std::string result(static_cast<std::size_t>(required), '\0');
  if (WideCharToMultiByte(
          CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
          result.data(), required, nullptr, nullptr) != required) {
    return "<invalid utf-16>";
  }
  return result;
}

std::string WindowsMessage(DWORD error) {
  wchar_t* buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, error, 0, reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  LocalAllocation allocation(buffer);
  if (length == 0 || buffer == nullptr) {
    return "Win32 error " + std::to_string(error);
  }
  std::wstring value(buffer, length);
  while (!value.empty() &&
         (value.back() == L'\r' || value.back() == L'\n' || value.back() == L' ')) {
    value.pop_back();
  }
  return Utf8(value) + " (Win32 " + std::to_string(error) + ")";
}

void WriteStderr(std::string_view value) {
  const HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  if (error == nullptr || error == INVALID_HANDLE_VALUE) {
    return;
  }
  DWORD written = 0;
  WriteFile(
      error, value.data(), static_cast<DWORD>(std::min<std::size_t>(
                               value.size(), std::numeric_limits<DWORD>::max())),
      &written, nullptr);
}

void Debug(std::string_view value) {
  wchar_t enabled[2]{};
  if (GetEnvironmentVariableW(
          L"LIBREWOLF_SECURE_PIPE_DEBUG", enabled,
          static_cast<DWORD>(std::size(enabled))) != 0 &&
      enabled[0] == L'1') {
    WriteStderr("[secure-pipe-helper] DEBUG: ");
    WriteStderr(value);
    WriteStderr("\n");
  }
}

int Fail(std::string_view code, std::string_view message) {
  WriteStderr("[secure-pipe-helper] ");
  WriteStderr(code);
  WriteStderr(": ");
  WriteStderr(message);
  WriteStderr("\n");
  return 1;
}

int FailWindows(std::string_view code, std::string_view action, DWORD error) {
  return Fail(code, std::string(action) + ": " + WindowsMessage(error));
}

std::string EscapeJson(std::string_view value) {
  std::string output;
  output.reserve(value.size() + 16);
  for (const unsigned char character : value) {
    switch (character) {
      case '"':
        output += "\\\"";
        break;
      case '\\':
        output += "\\\\";
        break;
      case '\b':
        output += "\\b";
        break;
      case '\f':
        output += "\\f";
        break;
      case '\n':
        output += "\\n";
        break;
      case '\r':
        output += "\\r";
        break;
      case '\t':
        output += "\\t";
        break;
      default:
        if (character < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          output += "\\u00";
          output.push_back(hex[(character >> 4U) & 0x0fU]);
          output.push_back(hex[character & 0x0fU]);
        } else {
          output.push_back(static_cast<char>(character));
        }
    }
  }
  return output;
}

enum class ReadResult {
  kOk,
  kCleanEnd,
  kTruncated,
  kError,
};

ReadResult ReadExact(HANDLE handle, void* destination, DWORD length, DWORD* error_out) {
  auto* cursor = static_cast<std::uint8_t*>(destination);
  DWORD total = 0;
  while (total < length) {
    DWORD read = 0;
    if (!ReadFile(handle, cursor + total, length - total, &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error_out != nullptr) {
        *error_out = error;
      }
      if ((error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF ||
           error == ERROR_OPERATION_ABORTED) &&
          total == 0) {
        return ReadResult::kCleanEnd;
      }
      return total == 0 ? ReadResult::kError : ReadResult::kTruncated;
    }
    if (read == 0) {
      return total == 0 ? ReadResult::kCleanEnd : ReadResult::kTruncated;
    }
    total += read;
  }
  return ReadResult::kOk;
}

bool WriteAll(HANDLE handle, const void* source, DWORD length, DWORD* error_out) {
  const auto* cursor = static_cast<const std::uint8_t*>(source);
  DWORD total = 0;
  while (total < length) {
    DWORD written = 0;
    if (!WriteFile(handle, cursor + total, length - total, &written, nullptr)) {
      if (error_out != nullptr) {
        *error_out = GetLastError();
      }
      return false;
    }
    if (written == 0) {
      if (error_out != nullptr) {
        *error_out = ERROR_WRITE_FAULT;
      }
      return false;
    }
    total += written;
  }
  return true;
}

ReadResult ReadExactOverlapped(
    HANDLE handle, void* destination, DWORD length, DWORD* error_out) {
  auto* cursor = static_cast<std::uint8_t*>(destination);
  DWORD total = 0;
  UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.valid()) {
    if (error_out != nullptr) {
      *error_out = GetLastError();
    }
    return ReadResult::kError;
  }
  while (total < length) {
    ResetEvent(event.get());
    OVERLAPPED operation{};
    operation.hEvent = event.get();
    DWORD read = 0;
    if (!ReadFile(
            handle, cursor + total, length - total, &read, &operation)) {
      DWORD error = GetLastError();
      if (error == ERROR_IO_PENDING) {
        const DWORD wait = WaitForSingleObject(event.get(), INFINITE);
        if (wait == WAIT_OBJECT_0 &&
            GetOverlappedResult(handle, &operation, &read, FALSE)) {
          error = ERROR_SUCCESS;
        } else {
          error = wait == WAIT_OBJECT_0 ? GetLastError() : ERROR_OPERATION_ABORTED;
        }
      }
      if (error != ERROR_SUCCESS) {
        if (error_out != nullptr) {
          *error_out = error;
        }
        if ((error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF ||
             error == ERROR_OPERATION_ABORTED) &&
            total == 0) {
          return ReadResult::kCleanEnd;
        }
        return total == 0 ? ReadResult::kError : ReadResult::kTruncated;
      }
    }
    if (read == 0) {
      return total == 0 ? ReadResult::kCleanEnd : ReadResult::kTruncated;
    }
    total += read;
  }
  return ReadResult::kOk;
}

bool WriteAllOverlapped(
    HANDLE handle, const void* source, DWORD length, DWORD* error_out) {
  const auto* cursor = static_cast<const std::uint8_t*>(source);
  DWORD total = 0;
  UniqueHandle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!event.valid()) {
    if (error_out != nullptr) {
      *error_out = GetLastError();
    }
    return false;
  }
  while (total < length) {
    ResetEvent(event.get());
    OVERLAPPED operation{};
    operation.hEvent = event.get();
    DWORD written = 0;
    if (!WriteFile(
            handle, cursor + total, length - total, &written, &operation)) {
      DWORD error = GetLastError();
      if (error == ERROR_IO_PENDING) {
        const DWORD wait = WaitForSingleObject(event.get(), INFINITE);
        if (wait == WAIT_OBJECT_0 &&
            GetOverlappedResult(handle, &operation, &written, FALSE)) {
          error = ERROR_SUCCESS;
        } else {
          error = wait == WAIT_OBJECT_0 ? GetLastError() : ERROR_OPERATION_ABORTED;
        }
      }
      if (error != ERROR_SUCCESS) {
        if (error_out != nullptr) {
          *error_out = error;
        }
        return false;
      }
    }
    if (written == 0) {
      if (error_out != nullptr) {
        *error_out = ERROR_WRITE_FAULT;
      }
      return false;
    }
    total += written;
  }
  return true;
}

std::array<std::uint8_t, 4> EncodeLength(std::uint32_t length) {
  return {
      static_cast<std::uint8_t>(length & 0xffU),
      static_cast<std::uint8_t>((length >> 8U) & 0xffU),
      static_cast<std::uint8_t>((length >> 16U) & 0xffU),
      static_cast<std::uint8_t>((length >> 24U) & 0xffU),
  };
}

std::uint32_t DecodeLength(const std::array<std::uint8_t, 4>& bytes) {
  return static_cast<std::uint32_t>(bytes[0]) |
         (static_cast<std::uint32_t>(bytes[1]) << 8U) |
         (static_cast<std::uint32_t>(bytes[2]) << 16U) |
         (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

bool WriteFrame(HANDLE handle, std::string_view body, DWORD* error_out) {
  if (body.empty() || body.size() > kMaximumFrameBytes) {
    if (error_out != nullptr) {
      *error_out = ERROR_INVALID_DATA;
    }
    return false;
  }
  const auto prefix = EncodeLength(static_cast<std::uint32_t>(body.size()));
  return WriteAll(handle, prefix.data(), static_cast<DWORD>(prefix.size()), error_out) &&
         WriteAll(handle, body.data(), static_cast<DWORD>(body.size()), error_out);
}

std::optional<std::wstring> Argument(
    const std::vector<std::wstring>& arguments, std::wstring_view name) {
  for (std::size_t index = 0; index + 1 < arguments.size(); ++index) {
    if (arguments[index] == name) {
      return arguments[index + 1];
    }
  }
  return std::nullopt;
}

std::optional<DWORD> ParseProcessId(const std::optional<std::wstring>& value) {
  if (!value.has_value() || value->empty()) {
    return std::nullopt;
  }
  wchar_t* end = nullptr;
  const unsigned long parsed = std::wcstoul(value->c_str(), &end, 10);
  if (end == value->c_str() || *end != L'\0' || parsed == 0 ||
      parsed > std::numeric_limits<DWORD>::max()) {
    return std::nullopt;
  }
  return static_cast<DWORD>(parsed);
}

std::optional<DWORD> ParseMilliseconds(
    const std::optional<std::wstring>& value, DWORD default_value) {
  if (!value.has_value()) {
    return default_value;
  }
  wchar_t* end = nullptr;
  const unsigned long parsed = std::wcstoul(value->c_str(), &end, 10);
  if (end == value->c_str() || *end != L'\0' || parsed == 0 ||
      parsed > 120000UL) {
    return std::nullopt;
  }
  return static_cast<DWORD>(parsed);
}

bool IsValidPipeName(std::wstring_view name) {
  if (name.size() <= kPipePrefix.size() || name.size() > 240 ||
      !name.starts_with(kPipePrefix)) {
    return false;
  }
  bool component_has_character = false;
  for (const wchar_t character : name.substr(kPipePrefix.size())) {
    if (character == L'\\') {
      if (!component_has_character) {
        return false;
      }
      component_has_character = false;
      continue;
    }
    const bool allowed =
        (character >= L'a' && character <= L'z') ||
        (character >= L'A' && character <= L'Z') ||
        (character >= L'0' && character <= L'9') || character == L'-' ||
        character == L'_' || character == L'.';
    if (!allowed) {
      return false;
    }
    component_has_character = true;
  }
  return component_has_character && name.find(L"..") == std::wstring_view::npos;
}

std::optional<std::vector<std::uint8_t>> TokenUserSid(HANDLE token) {
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    return std::nullopt;
  }
  std::vector<std::uint8_t> information(required);
  if (!GetTokenInformation(
          token, TokenUser, information.data(), required, &required)) {
    return std::nullopt;
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(information.data());
  if (!IsValidSid(user->User.Sid)) {
    return std::nullopt;
  }
  const DWORD sid_length = GetLengthSid(user->User.Sid);
  std::vector<std::uint8_t> sid(sid_length);
  if (!CopySid(sid_length, sid.data(), user->User.Sid)) {
    return std::nullopt;
  }
  return sid;
}

std::optional<std::vector<std::uint8_t>> CurrentUserSid() {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) {
    return std::nullopt;
  }
  UniqueHandle token(raw_token);
  return TokenUserSid(token.get());
}

std::optional<std::vector<std::uint8_t>> ProcessUserSid(HANDLE process) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &raw_token)) {
    return std::nullopt;
  }
  UniqueHandle token(raw_token);
  return TokenUserSid(token.get());
}

std::string SidString(PSID sid) {
  wchar_t* value = nullptr;
  if (!ConvertSidToStringSidW(sid, &value) || value == nullptr) {
    return "<unavailable>";
  }
  LocalAllocation allocation(value);
  return Utf8(value);
}

std::uint64_t FiletimeValue(const FILETIME& value) {
  ULARGE_INTEGER combined{};
  combined.LowPart = value.dwLowDateTime;
  combined.HighPart = value.dwHighDateTime;
  return combined.QuadPart;
}

std::optional<std::uint64_t> ProcessCreatedAt(HANDLE process) {
  FILETIME created{};
  FILETIME exited{};
  FILETIME kernel{};
  FILETIME user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) {
    return std::nullopt;
  }
  return FiletimeValue(created);
}

bool VerifyProcessIdentity(
    DWORD process_id, PSID current_user, const std::optional<std::wstring>& expected_created_at,
    UniqueHandle* process_out, std::string* error_out) {
  UniqueHandle process(OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, process_id));
  if (!process.valid()) {
    *error_out = "cannot open process " + std::to_string(process_id) + ": " +
                 WindowsMessage(GetLastError());
    return false;
  }
  const auto process_sid = ProcessUserSid(process.get());
  if (!process_sid.has_value() ||
      !EqualSid(current_user, const_cast<std::uint8_t*>(process_sid->data()))) {
    *error_out = "process belongs to a different Windows user";
    return false;
  }
  if (expected_created_at.has_value()) {
    const auto actual = ProcessCreatedAt(process.get());
    wchar_t* end = nullptr;
    const unsigned long long expected =
        std::wcstoull(expected_created_at->c_str(), &end, 10);
    if (end == expected_created_at->c_str() || *end != L'\0' ||
        !actual.has_value() || actual.value() != expected) {
      *error_out = "process creation time does not match discovery";
      return false;
    }
  }
  *process_out = std::move(process);
  return true;
}

class PrivateSecurityAttributes {
 public:
  PrivateSecurityAttributes(PSID user_sid, DWORD access_mask) {
    EXPLICIT_ACCESSW access{};
    access.grfAccessPermissions = access_mask;
    access.grfAccessMode = SET_ACCESS;
    access.grfInheritance = NO_INHERITANCE;
    access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    access.Trustee.TrusteeType = TRUSTEE_IS_USER;
    access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(user_sid);

    PACL raw_acl = nullptr;
    status_ = SetEntriesInAclW(1, &access, nullptr, &raw_acl);
    acl_.reset(raw_acl);
    if (status_ != ERROR_SUCCESS) {
      return;
    }
    if (!InitializeSecurityDescriptor(&descriptor_, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&descriptor_, user_sid, FALSE) ||
        !SetSecurityDescriptorDacl(
            &descriptor_, TRUE, static_cast<PACL>(acl_.get()), FALSE) ||
        !SetSecurityDescriptorControl(
            &descriptor_, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
      status_ = GetLastError();
      return;
    }
    attributes_.nLength = sizeof(attributes_);
    attributes_.lpSecurityDescriptor = &descriptor_;
    attributes_.bInheritHandle = FALSE;
  }

  [[nodiscard]] bool valid() const { return status_ == ERROR_SUCCESS; }
  [[nodiscard]] DWORD status() const { return status_; }
  [[nodiscard]] SECURITY_ATTRIBUTES* get() { return &attributes_; }

 private:
  SECURITY_DESCRIPTOR descriptor_{};
  LocalAllocation acl_;
  SECURITY_ATTRIBUTES attributes_{};
  DWORD status_ = ERROR_SUCCESS;
};

bool VerifyPrivateSecurity(
    HANDLE handle, SE_OBJECT_TYPE object_type, PSID current_user,
    DWORD required_access, std::string* error_out) {
  PSID owner = nullptr;
  PACL dacl = nullptr;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  const DWORD status = GetSecurityInfo(
      handle, object_type, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &dacl, nullptr, &raw_descriptor);
  LocalAllocation descriptor(raw_descriptor);
  if (status != ERROR_SUCCESS) {
    *error_out = "cannot read object security descriptor: " + WindowsMessage(status);
    return false;
  }
  if (owner == nullptr || !IsValidSid(owner) || !EqualSid(owner, current_user)) {
    *error_out = "object owner is not the current Windows user";
    return false;
  }
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL descriptor_dacl = nullptr;
  if (!GetSecurityDescriptorDacl(
          raw_descriptor, &dacl_present, &descriptor_dacl, &dacl_defaulted) ||
      !dacl_present || descriptor_dacl == nullptr || descriptor_dacl != dacl) {
    *error_out = "object has a missing or null DACL";
    return false;
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  if (!GetSecurityDescriptorControl(raw_descriptor, &control, &revision) ||
      (control & SE_DACL_PROTECTED) == 0) {
    *error_out = "object DACL is not protected from inheritance";
    return false;
  }
  ACL_SIZE_INFORMATION information{};
  if (!GetAclInformation(
          dacl, &information, sizeof(information), AclSizeInformation) ||
      information.AceCount != 1) {
    *error_out = "object DACL must contain exactly one explicit ACE";
    return false;
  }
  void* raw_ace = nullptr;
  if (!GetAce(dacl, 0, &raw_ace) || raw_ace == nullptr) {
    *error_out = "object DACL ACE cannot be read";
    return false;
  }
  const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE ||
      (header->AceFlags &
       (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERITED_ACE)) != 0) {
    *error_out = "object DACL is not one non-inheritable allow ACE";
    return false;
  }
  const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
  PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
  if (!IsValidSid(ace_sid) || !EqualSid(ace_sid, current_user)) {
    *error_out = "object DACL grants access to a principal other than the current user";
    return false;
  }
  if ((ace->Mask & required_access) != required_access) {
    *error_out = "object DACL does not grant the current user required access";
    return false;
  }
  return true;
}

bool VerifyPrivateFile(
    const std::wstring& path, PSID current_user, std::string* error_out) {
  UniqueHandle file(CreateFileW(
      path.c_str(), READ_CONTROL, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) {
    *error_out = "cannot open discovery file for ACL verification: " +
                 WindowsMessage(GetLastError());
    return false;
  }
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(file.get(), &information) ||
      (information.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    *error_out = "discovery path is not a regular, non-reparse-point file";
    return false;
  }
  return VerifyPrivateSecurity(
      file.get(), SE_FILE_OBJECT, current_user, kFileAccessMask, error_out);
}

std::optional<std::vector<std::uint8_t>> ReadSingleFrame(
    HANDLE handle, DWORD maximum_bytes, std::string* error_out) {
  std::vector<std::uint8_t> input(maximum_bytes + 5U);
  DWORD used = 0;
  while (used < input.size()) {
    DWORD read = 0;
    if (!ReadFile(
            handle, input.data() + used,
            static_cast<DWORD>(input.size() - used), &read, nullptr)) {
      const DWORD error = GetLastError();
      if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) {
        break;
      }
      *error_out =
          "cannot read framed discovery payload: " + WindowsMessage(error);
      return std::nullopt;
    }
    if (read == 0) {
      break;
    }
    used += read;
  }
  if (used < 4) {
    *error_out = "cannot read framed discovery payload";
    return std::nullopt;
  }
  std::array<std::uint8_t, 4> prefix{};
  std::copy_n(input.begin(), 4, prefix.begin());
  const std::uint32_t length = DecodeLength(prefix);
  if (length == 0 || length > maximum_bytes || used != length + 4U) {
    *error_out =
        "discovery helper requires exactly one complete frame of at most 64 KiB";
    return std::nullopt;
  }
  return std::vector<std::uint8_t>(
      input.begin() + 4, input.begin() + 4 + length);
}

std::optional<std::wstring> CanonicalLocalPath(
    const std::wstring& input, bool directory, std::string* error_out) {
  if (input.empty() || input.starts_with(L"\\\\") ||
      input.find(L'\0') != std::wstring::npos) {
    *error_out = "path must be an absolute local drive path";
    return std::nullopt;
  }
  const DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (required == 0) {
    *error_out = "GetFullPathNameW failed: " + WindowsMessage(GetLastError());
    return std::nullopt;
  }
  std::wstring full(required, L'\0');
  const DWORD written =
      GetFullPathNameW(input.c_str(), required, full.data(), nullptr);
  if (written == 0 || written >= required) {
    *error_out = "GetFullPathNameW returned an invalid path";
    return std::nullopt;
  }
  full.resize(written);
  if (full.size() < 4 ||
      !((full[0] >= L'A' && full[0] <= L'Z') ||
        (full[0] >= L'a' && full[0] <= L'z')) ||
      full[1] != L':' || full[2] != L'\\' ||
      full.find(L':', 2) != std::wstring::npos ||
      full.find(L"..") != std::wstring::npos) {
    *error_out = "path must be a normalized local drive path without streams";
    return std::nullopt;
  }
  while (full.size() > 3 && full.back() == L'\\') {
    full.pop_back();
  }
  if (!directory && full.size() <= 3) {
    *error_out = "discovery path must name a file";
    return std::nullopt;
  }
  return full;
}

std::wstring ParentPath(const std::wstring& path) {
  const std::size_t separator = path.find_last_of(L'\\');
  if (separator == std::wstring::npos) {
    return {};
  }
  return path.substr(0, separator);
}

bool EqualPathPrefix(
    std::wstring_view candidate, std::wstring_view prefix) {
  return candidate.size() >= prefix.size() &&
         CompareStringOrdinal(
             candidate.data(), static_cast<int>(prefix.size()), prefix.data(),
             static_cast<int>(prefix.size()), TRUE) == CSTR_EQUAL;
}

bool PathIsInside(
    const std::wstring& path, const std::wstring& root) {
  return path.size() > root.size() && EqualPathPrefix(path, root) &&
         path[root.size()] == L'\\';
}

bool OpenAndVerifyPrivateDirectory(
    const std::wstring& path, PSID current_user, std::string* error_out) {
  UniqueHandle directory(CreateFileW(
      path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!directory.valid()) {
    *error_out =
        "cannot open private directory: " + WindowsMessage(GetLastError());
    return false;
  }
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(directory.get(), &information) ||
      (information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error_out = "private directory path is not a non-reparse directory";
    return false;
  }
  return VerifyPrivateSecurity(
      directory.get(), SE_FILE_OBJECT, current_user, kDirectoryAccessMask,
      error_out);
}

bool EnsureOnePrivateDirectory(
    const std::wstring& path, PSID current_user,
    PrivateSecurityAttributes* security, std::string* error_out) {
  if (!CreateDirectoryW(path.c_str(), security->get())) {
    const DWORD error = GetLastError();
    if (error != ERROR_ALREADY_EXISTS) {
      *error_out =
          "cannot create private directory: " + WindowsMessage(error);
      return false;
    }
  }
  return OpenAndVerifyPrivateDirectory(path, current_user, error_out);
}

bool EnsurePrivateDirectoryTree(
    const std::wstring& root, const std::wstring& file_path, PSID current_user,
    std::string* error_out) {
  if (!PathIsInside(file_path, root) || root.size() <= 3) {
    *error_out = "discovery file must be below the private runtime root";
    return false;
  }
  const std::wstring root_parent = ParentPath(root);
  const DWORD parent_attributes = GetFileAttributesW(root_parent.c_str());
  if (root_parent.empty() || parent_attributes == INVALID_FILE_ATTRIBUTES ||
      (parent_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (parent_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    *error_out = "private runtime root parent must already be a local directory";
    return false;
  }
  PrivateSecurityAttributes directory_security(
      current_user, kDirectoryAccessMask);
  if (!directory_security.valid()) {
    *error_out = "cannot create private directory security descriptor: " +
                 WindowsMessage(directory_security.status());
    return false;
  }
  if (!EnsureOnePrivateDirectory(
          root, current_user, &directory_security, error_out)) {
    return false;
  }
  const std::wstring file_parent = ParentPath(file_path);
  if (file_parent.empty() || !PathIsInside(file_parent + L"\\_", root)) {
    *error_out = "discovery parent is outside the private runtime root";
    return false;
  }
  std::size_t cursor = root.size() + 1;
  while (cursor <= file_parent.size()) {
    const std::size_t separator = file_parent.find(L'\\', cursor);
    const std::size_t end =
        separator == std::wstring::npos ? file_parent.size() : separator;
    const std::wstring component = file_parent.substr(0, end);
    if (!EnsureOnePrivateDirectory(
            component, current_user, &directory_security, error_out)) {
      return false;
    }
    if (separator == std::wstring::npos) {
      break;
    }
    cursor = separator + 1;
  }
  return true;
}

std::optional<std::wstring> RandomTemporaryPath(
    const std::wstring& file_path, std::string* error_out) {
  std::array<std::uint8_t, 16> random{};
  const NTSTATUS status = BCryptGenRandom(
      nullptr, random.data(), static_cast<ULONG>(random.size()),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status < 0) {
    *error_out = "BCryptGenRandom failed";
    return std::nullopt;
  }
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring suffix;
  suffix.reserve(random.size() * 2);
  for (const std::uint8_t byte : random) {
    suffix.push_back(hex[(byte >> 4U) & 0x0fU]);
    suffix.push_back(hex[byte & 0x0fU]);
  }
  return ParentPath(file_path) + L"\\.discovery-" + suffix + L".tmp";
}

int WriteDiscoveryMain(
    const std::vector<std::wstring>& arguments, PSID current_user) {
  std::string path_error;
  const auto raw_path = Argument(arguments, L"--path");
  const auto raw_root = Argument(arguments, L"--root");
  if (!raw_path.has_value() || !raw_root.has_value()) {
    return Fail(
        "INVALID_ARGUMENT", "--path and --root are required");
  }
  const auto path = CanonicalLocalPath(*raw_path, false, &path_error);
  const auto root = CanonicalLocalPath(*raw_root, true, &path_error);
  if (!path.has_value() || !root.has_value()) {
    return Fail("INVALID_DISCOVERY_PATH", path_error);
  }
  if (!EnsurePrivateDirectoryTree(
          *root, *path, current_user, &path_error)) {
    return Fail("DISCOVERY_DIRECTORY_SECURITY_FAILED", path_error);
  }
  const auto payload = ReadSingleFrame(
      GetStdHandle(STD_INPUT_HANDLE), kMaximumDiscoveryBytes, &path_error);
  if (!payload.has_value()) {
    return Fail("INVALID_DISCOVERY_PAYLOAD", path_error);
  }

  PrivateSecurityAttributes file_security(current_user, kFileAccessMask);
  if (!file_security.valid()) {
    return FailWindows(
        "SECURITY_DESCRIPTOR_FAILED",
        "cannot build discovery file DACL", file_security.status());
  }
  const auto temporary_path = RandomTemporaryPath(*path, &path_error);
  if (!temporary_path.has_value()) {
    return Fail("DISCOVERY_TEMP_FAILED", path_error);
  }
  UniqueHandle temporary(CreateFileW(
      temporary_path->c_str(),
      GENERIC_WRITE | READ_CONTROL | DELETE, 0, file_security.get(), CREATE_NEW,
      FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY |
          FILE_FLAG_WRITE_THROUGH,
      nullptr));
  if (!temporary.valid()) {
    return FailWindows(
        "DISCOVERY_TEMP_FAILED", "cannot create private temporary file",
        GetLastError());
  }
  DWORD write_error = ERROR_SUCCESS;
  if (!WriteAll(
          temporary.get(), payload->data(),
          static_cast<DWORD>(payload->size()), &write_error) ||
      !FlushFileBuffers(temporary.get())) {
    const DWORD error =
        write_error == ERROR_SUCCESS ? GetLastError() : write_error;
    temporary.reset();
    DeleteFileW(temporary_path->c_str());
    return FailWindows(
        "DISCOVERY_WRITE_FAILED", "cannot durably write discovery file",
        error);
  }
  std::string security_error;
  if (!VerifyPrivateSecurity(
          temporary.get(), SE_FILE_OBJECT, current_user, kFileAccessMask,
          &security_error)) {
    temporary.reset();
    DeleteFileW(temporary_path->c_str());
    return Fail("DISCOVERY_ACL_VERIFICATION_FAILED", security_error);
  }
  temporary.reset();
  if (!MoveFileExW(
          temporary_path->c_str(), path->c_str(),
          MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    const DWORD error = GetLastError();
    DeleteFileW(temporary_path->c_str());
    return FailWindows(
        "DISCOVERY_PUBLISH_FAILED",
        "cannot atomically publish discovery file", error);
  }
  if (!VerifyPrivateFile(*path, current_user, &security_error)) {
    return Fail("DISCOVERY_ACL_VERIFICATION_FAILED", security_error);
  }
  const std::string event =
      "{\"$securePipeHelper\":{\"event\":\"published\",\"version\":1,"
      "\"mode\":\"file\",\"currentUserSid\":\"" +
      EscapeJson(SidString(current_user)) +
      "\",\"dacl\":\"current-user-only\"}}";
  if (!WriteFrame(
          GetStdHandle(STD_OUTPUT_HANDLE), event, &write_error)) {
    return FailWindows(
        "CONTROL_CHANNEL_FAILED", "cannot write published event",
        write_error);
  }
  return 0;
}

int RemoveDiscoveryMain(
    const std::vector<std::wstring>& arguments, PSID current_user) {
  std::string path_error;
  const auto raw_path = Argument(arguments, L"--path");
  const auto raw_root = Argument(arguments, L"--root");
  if (!raw_path.has_value() || !raw_root.has_value()) {
    return Fail(
        "INVALID_ARGUMENT", "--path and --root are required");
  }
  const auto path = CanonicalLocalPath(*raw_path, false, &path_error);
  const auto root = CanonicalLocalPath(*raw_root, true, &path_error);
  if (!path.has_value() || !root.has_value() ||
      !PathIsInside(*path, *root)) {
    return Fail(
        "INVALID_DISCOVERY_PATH",
        path_error.empty() ? "discovery path is outside the private root"
                           : path_error);
  }
  const auto expected = ReadSingleFrame(
      GetStdHandle(STD_INPUT_HANDLE), kMaximumDiscoveryBytes, &path_error);
  if (!expected.has_value()) {
    return Fail("INVALID_DISCOVERY_PAYLOAD", path_error);
  }
  if (!OpenAndVerifyPrivateDirectory(*root, current_user, &path_error) ||
      !OpenAndVerifyPrivateDirectory(
          ParentPath(*path), current_user, &path_error)) {
    return Fail("DISCOVERY_DIRECTORY_SECURITY_FAILED", path_error);
  }
  UniqueHandle file(CreateFileW(
      path->c_str(), GENERIC_READ | READ_CONTROL | DELETE, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.valid()) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) {
      return 0;
    }
    return FailWindows(
        "DISCOVERY_REMOVE_FAILED", "cannot open discovery file",
        GetLastError());
  }
  BY_HANDLE_FILE_INFORMATION information{};
  std::string security_error;
  if (!GetFileInformationByHandle(file.get(), &information) ||
      (information.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
      !VerifyPrivateSecurity(
          file.get(), SE_FILE_OBJECT, current_user, kFileAccessMask,
          &security_error)) {
    return Fail(
        "DISCOVERY_REMOVE_FAILED",
        security_error.empty() ? "discovery file is not a private regular file"
                               : security_error);
  }
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.get(), &size) || size.QuadPart <= 0 ||
      size.QuadPart > kMaximumDiscoveryBytes) {
    return Fail(
        "DISCOVERY_REMOVE_FAILED", "discovery file size is invalid");
  }
  std::vector<std::uint8_t> actual(static_cast<std::size_t>(size.QuadPart));
  DWORD read_error = ERROR_SUCCESS;
  if (ReadExact(
          file.get(), actual.data(), static_cast<DWORD>(actual.size()),
          &read_error) != ReadResult::kOk ||
      actual != expected.value()) {
    return Fail(
        "DISCOVERY_CHANGED",
        "refusing to remove a discovery record changed by another session");
  }
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          file.get(), FileDispositionInfo, &disposition,
          sizeof(disposition))) {
    return FailWindows(
        "DISCOVERY_REMOVE_FAILED", "cannot mark discovery file for deletion",
        GetLastError());
  }
  file.reset();
  DWORD output_error = ERROR_SUCCESS;
  const std::string event =
      "{\"$securePipeHelper\":{\"event\":\"removed\",\"version\":1,"
      "\"mode\":\"file\",\"currentUserSid\":\"" +
      EscapeJson(SidString(current_user)) + "\"}}";
  if (!WriteFrame(
          GetStdHandle(STD_OUTPUT_HANDLE), event, &output_error)) {
    return FailWindows(
        "CONTROL_CHANNEL_FAILED", "cannot write removed event",
        output_error);
  }
  return 0;
}

DWORD WINAPI ParentMonitor(void* raw_process) {
  const HANDLE process = raw_process;
  WaitForSingleObject(process, INFINITE);
  ExitProcess(90);
}

bool StartParentMonitor(
    DWORD parent_pid, PSID current_user, UniqueHandle* parent_process,
    std::string* error_out) {
  if (!VerifyProcessIdentity(
          parent_pid, current_user, std::nullopt, parent_process, error_out)) {
    return false;
  }
  UniqueHandle thread(CreateThread(
      nullptr, 0, ParentMonitor, parent_process->get(), 0, nullptr));
  if (!thread.valid()) {
    *error_out = "cannot start parent-death monitor: " +
                 WindowsMessage(GetLastError());
    return false;
  }
  return true;
}

struct RelayContext {
  HANDLE source = INVALID_HANDLE_VALUE;
  HANDLE destination = INVALID_HANDLE_VALUE;
  HANDLE stopped = INVALID_HANDLE_VALUE;
  volatile LONG* failure = nullptr;
  const char* label = "unknown";
  bool source_overlapped = false;
  bool destination_overlapped = false;
};

DWORD WINAPI RelayFrames(void* raw_context) {
  auto* context = static_cast<RelayContext*>(raw_context);
  while (true) {
    std::array<std::uint8_t, 4> prefix{};
    DWORD error = ERROR_SUCCESS;
    const ReadResult prefix_result = context->source_overlapped
        ? ReadExactOverlapped(
              context->source, prefix.data(),
              static_cast<DWORD>(prefix.size()), &error)
        : ReadExact(
              context->source, prefix.data(),
              static_cast<DWORD>(prefix.size()), &error);
    if (prefix_result == ReadResult::kCleanEnd) {
      Debug(std::string(context->label) + " reached clean end");
      break;
    }
    if (prefix_result != ReadResult::kOk) {
      WriteStderr(
          "[secure-pipe-helper] FRAME_READ_FAILED: " +
          WindowsMessage(error) + "\n");
      InterlockedCompareExchange(context->failure, 1, 0);
      break;
    }
    const std::uint32_t length = DecodeLength(prefix);
    Debug(
        std::string(context->label) + " received frame prefix with " +
        std::to_string(length) + " bytes");
    DWORD available = 0;
    if (PeekNamedPipe(
            context->source, nullptr, 0, nullptr, &available, nullptr)) {
      Debug(
          std::string(context->label) + " source has " +
          std::to_string(available) + " bytes available");
    }
    if (length == 0 || length > kMaximumFrameBytes) {
      InterlockedCompareExchange(context->failure, 1, 0);
      break;
    }
    std::vector<std::uint8_t> body(length);
    const ReadResult body_result = context->source_overlapped
        ? ReadExactOverlapped(
              context->source, body.data(), length, &error)
        : ReadExact(context->source, body.data(), length, &error);
    Debug(std::string(context->label) + " completed body read");
    const bool prefix_written =
        body_result == ReadResult::kOk &&
        (context->destination_overlapped
             ? WriteAllOverlapped(
                   context->destination, prefix.data(),
                   static_cast<DWORD>(prefix.size()), &error)
             : WriteAll(
                   context->destination, prefix.data(),
                   static_cast<DWORD>(prefix.size()), &error));
    Debug(std::string(context->label) + " completed prefix write");
    const bool body_written =
        prefix_written &&
        (context->destination_overlapped
             ? WriteAllOverlapped(
                   context->destination, body.data(), length, &error)
             : WriteAll(
                   context->destination, body.data(), length, &error));
    if (body_result != ReadResult::kOk || !prefix_written || !body_written) {
      if (error != ERROR_BROKEN_PIPE && error != ERROR_OPERATION_ABORTED &&
          error != ERROR_HANDLE_EOF) {
        WriteStderr(
            "[secure-pipe-helper] FRAME_COPY_FAILED: " +
            WindowsMessage(error) + "\n");
        InterlockedCompareExchange(context->failure, 1, 0);
      }
      break;
    }
    Debug(
        std::string(context->label) + " relayed frame with " +
        std::to_string(length) + " bytes");
  }
  SetEvent(context->stopped);
  return 0;
}

int RunRelay(HANDLE pipe, bool server_end) {
  Debug(
      "starting relay pid " + std::to_string(GetCurrentProcessId()) +
      (server_end ? " server" : " client"));
  DWORD stdio_flags = 0;
  if (GetNamedPipeInfo(
          GetStdHandle(STD_INPUT_HANDLE), &stdio_flags, nullptr, nullptr,
          nullptr)) {
    Debug("stdin pipe flags " + std::to_string(stdio_flags));
  }
  DWORD transport_flags = 0;
  if (GetNamedPipeInfo(pipe, &transport_flags, nullptr, nullptr, nullptr)) {
    Debug("transport pipe flags " + std::to_string(transport_flags));
  }
  UniqueHandle stopped(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!stopped.valid()) {
    return FailWindows("RELAY_INIT_FAILED", "CreateEventW failed", GetLastError());
  }
  volatile LONG failure = 0;
  RelayContext to_pipe{
      GetStdHandle(STD_INPUT_HANDLE), pipe, stopped.get(), &failure,
      "stdio-to-pipe", false, true};
  RelayContext from_pipe{
      pipe, GetStdHandle(STD_OUTPUT_HANDLE), stopped.get(), &failure,
      "pipe-to-stdio", true, false};
  UniqueHandle input_thread(CreateThread(
      nullptr, 0, RelayFrames, &to_pipe, 0, nullptr));
  UniqueHandle output_thread(CreateThread(
      nullptr, 0, RelayFrames, &from_pipe, 0, nullptr));
  if (!input_thread.valid() || !output_thread.valid()) {
    return FailWindows("RELAY_INIT_FAILED", "CreateThread failed", GetLastError());
  }

  WaitForSingleObject(stopped.get(), INFINITE);
  Debug(
      "stopping relay pid " + std::to_string(GetCurrentProcessId()) +
      " failure=" + std::to_string(failure));
  CancelIoEx(pipe, nullptr);
  CancelSynchronousIo(input_thread.get());
  CancelSynchronousIo(output_thread.get());
  WaitForSingleObject(input_thread.get(), 5000);
  WaitForSingleObject(output_thread.get(), 5000);
  if (server_end) {
    DisconnectNamedPipe(pipe);
  }
  return failure == 0 ? 0 : Fail("FRAME_RELAY_FAILED", "framed transport relay failed");
}

std::string ListeningEvent(
    const std::wstring& pipe_name, DWORD process_id, std::uint64_t created_at,
    PSID current_user) {
  return "{\"$securePipeHelper\":{\"event\":\"listening\",\"version\":1,"
         "\"mode\":\"server\",\"pipeName\":\"" +
         EscapeJson(Utf8(pipe_name)) + "\",\"ownerPid\":" +
         std::to_string(process_id) + ",\"ownerCreatedAtFiletime\":\"" +
         std::to_string(created_at) + "\",\"currentUserSid\":\"" +
         EscapeJson(SidString(current_user)) +
         "\",\"dacl\":\"current-user-only\",\"remoteClientsRejected\":true}}";
}

std::string ConnectedEvent(
    std::string_view mode, std::string_view peer_label, DWORD peer_pid,
    PSID current_user) {
  return "{\"$securePipeHelper\":{\"event\":\"connected\",\"version\":1,"
         "\"mode\":\"" +
         std::string(mode) + "\",\"" + std::string(peer_label) + "\":" +
         std::to_string(peer_pid) + ",\"currentUserSid\":\"" +
         EscapeJson(SidString(current_user)) +
         "\",\"daclVerified\":true,\"transportPrefaceVerified\":true}}";
}

int ServerMain(
    const std::vector<std::wstring>& arguments, PSID current_user,
    DWORD parent_pid) {
  const auto pipe_name = Argument(arguments, L"--pipe-name");
  if (!pipe_name.has_value() || !IsValidPipeName(*pipe_name)) {
    return Fail(
        "INVALID_PIPE_NAME",
        "pipe name must be local and inside \\\\.\\pipe\\librewolf-agent-bridge\\");
  }

  PrivateSecurityAttributes security(current_user, kPipeAccessMask);
  if (!security.valid()) {
    return FailWindows(
        "SECURITY_DESCRIPTOR_FAILED", "cannot build current-user-only DACL",
        security.status());
  }
  UniqueHandle pipe(CreateNamedPipeW(
      pipe_name->c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, kPipeBufferBytes, kPipeBufferBytes, 0, security.get()));
  if (!pipe.valid()) {
    return FailWindows(
        "PIPE_CREATE_FAILED", "CreateNamedPipeW failed", GetLastError());
  }
  std::string security_error;
  if (!VerifyPrivateSecurity(
          pipe.get(), SE_KERNEL_OBJECT, current_user, kPipeAccessMask,
          &security_error)) {
    return Fail("PIPE_ACL_VERIFICATION_FAILED", security_error);
  }
  DWORD server_pipe_flags = 0;
  if (!GetNamedPipeInfo(
          pipe.get(), &server_pipe_flags, nullptr, nullptr, nullptr) ||
      (server_pipe_flags & PIPE_REJECT_REMOTE_CLIENTS) == 0 ||
      (server_pipe_flags & PIPE_SERVER_END) == 0) {
    return Fail(
        "REMOTE_CLIENT_REJECTION_FAILED",
        "created pipe does not report PIPE_REJECT_REMOTE_CLIENTS");
  }

  const auto created_at = ProcessCreatedAt(GetCurrentProcess());
  if (!created_at.has_value()) {
    return FailWindows(
        "PROCESS_IDENTITY_FAILED", "GetProcessTimes failed", GetLastError());
  }
  DWORD output_error = ERROR_SUCCESS;
  const std::string listening = ListeningEvent(
      *pipe_name, GetCurrentProcessId(), *created_at, current_user);
  if (!WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), listening, &output_error)) {
    return FailWindows(
        "CONTROL_CHANNEL_FAILED", "cannot write listening event", output_error);
  }

  UniqueHandle connect_event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!connect_event.valid()) {
    return FailWindows(
        "PIPE_ACCEPT_FAILED", "CreateEventW failed", GetLastError());
  }
  OVERLAPPED connect_operation{};
  connect_operation.hEvent = connect_event.get();
  if (!ConnectNamedPipe(pipe.get(), &connect_operation)) {
    DWORD error = GetLastError();
    if (error == ERROR_IO_PENDING) {
      DWORD connected = 0;
      if (WaitForSingleObject(connect_event.get(), INFINITE) != WAIT_OBJECT_0 ||
          !GetOverlappedResult(
              pipe.get(), &connect_operation, &connected, FALSE)) {
        error = GetLastError();
        return FailWindows(
            "PIPE_ACCEPT_FAILED", "ConnectNamedPipe failed", error);
      }
    } else if (error != ERROR_PIPE_CONNECTED) {
      return FailWindows(
          "PIPE_ACCEPT_FAILED", "ConnectNamedPipe failed", error);
    }
  }
  ULONG client_pid_raw = 0;
  if (!GetNamedPipeClientProcessId(pipe.get(), &client_pid_raw) ||
      client_pid_raw == 0 ||
      client_pid_raw > std::numeric_limits<DWORD>::max()) {
    return FailWindows(
        "CLIENT_IDENTITY_FAILED", "GetNamedPipeClientProcessId failed",
        GetLastError());
  }
  const DWORD client_pid = static_cast<DWORD>(client_pid_raw);
  UniqueHandle client_process;
  std::string process_error;
  if (!VerifyProcessIdentity(
          client_pid, current_user, std::nullopt, &client_process,
          &process_error)) {
    return Fail("CLIENT_IDENTITY_FAILED", process_error);
  }

  if (!WriteAllOverlapped(
          pipe.get(), kTransportPreface.data(),
          static_cast<DWORD>(kTransportPreface.size()), &output_error)) {
    return FailWindows(
        "TRANSPORT_PREFACE_FAILED", "cannot write transport preface",
        output_error);
  }
  const std::string connected =
      ConnectedEvent("server", "clientPid", client_pid, current_user);
  if (!WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), connected, &output_error)) {
    return FailWindows(
        "CONTROL_CHANNEL_FAILED", "cannot write connected event", output_error);
  }
  (void)parent_pid;
  return RunRelay(pipe.get(), true);
}

int ClientMain(
    const std::vector<std::wstring>& arguments, PSID current_user,
    DWORD parent_pid) {
  const auto pipe_name = Argument(arguments, L"--pipe-name");
  const auto expected_server_pid =
      ParseProcessId(Argument(arguments, L"--expected-server-pid"));
  const auto expected_created_at =
      Argument(arguments, L"--expected-server-created-at");
  const auto timeout =
      ParseMilliseconds(Argument(arguments, L"--connect-timeout-ms"), 10000);
  if (!pipe_name.has_value() || !IsValidPipeName(*pipe_name)) {
    return Fail(
        "INVALID_PIPE_NAME",
        "pipe name must be local and inside \\\\.\\pipe\\librewolf-agent-bridge\\");
  }
  if (!expected_server_pid.has_value() || !timeout.has_value()) {
    return Fail(
        "INVALID_ARGUMENT",
        "expected server PID and connect timeout must be positive integers");
  }
  if (const auto discovery_path = Argument(arguments, L"--discovery-path");
      discovery_path.has_value()) {
    std::string file_error;
    if (!VerifyPrivateFile(*discovery_path, current_user, &file_error)) {
      return Fail("DISCOVERY_ACL_VERIFICATION_FAILED", file_error);
    }
  }

  const ULONGLONG deadline = GetTickCount64() + timeout.value();
  UniqueHandle pipe;
  while (GetTickCount64() < deadline) {
    pipe.reset(CreateFileW(
        pipe_name->c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0,
        nullptr, OPEN_EXISTING,
        FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT |
            SECURITY_IDENTIFICATION,
        nullptr));
    if (pipe.valid()) {
      break;
    }
    const DWORD error = GetLastError();
    if (error != ERROR_PIPE_BUSY && error != ERROR_FILE_NOT_FOUND) {
      return FailWindows(
          "PIPE_CONNECT_FAILED", "CreateFileW failed", error);
    }
    const DWORD remaining = static_cast<DWORD>(
        std::min<ULONGLONG>(deadline - GetTickCount64(), 250));
    if (remaining == 0) {
      break;
    }
    WaitNamedPipeW(pipe_name->c_str(), remaining);
  }
  if (!pipe.valid()) {
    return Fail(
        "PIPE_CONNECT_TIMEOUT",
        "timed out waiting for the secure named-pipe server");
  }

  ULONG server_pid_raw = 0;
  if (!GetNamedPipeServerProcessId(pipe.get(), &server_pid_raw) ||
      server_pid_raw == 0 ||
      server_pid_raw > std::numeric_limits<DWORD>::max()) {
    return FailWindows(
        "SERVER_IDENTITY_FAILED", "GetNamedPipeServerProcessId failed",
        GetLastError());
  }
  const DWORD server_pid = static_cast<DWORD>(server_pid_raw);
  if (server_pid != expected_server_pid.value()) {
    return Fail(
        "SERVER_IDENTITY_FAILED",
        "named-pipe server PID does not match discovery");
  }
  UniqueHandle server_process;
  std::string process_error;
  if (!VerifyProcessIdentity(
          server_pid, current_user, expected_created_at, &server_process,
          &process_error)) {
    return Fail("SERVER_IDENTITY_FAILED", process_error);
  }
  std::string security_error;
  if (!VerifyPrivateSecurity(
          pipe.get(), SE_KERNEL_OBJECT, current_user, kPipeAccessMask,
          &security_error)) {
    return Fail("PIPE_ACL_VERIFICATION_FAILED", security_error);
  }
  DWORD client_pipe_flags = 0;
  if (!GetNamedPipeInfo(
          pipe.get(), &client_pipe_flags, nullptr, nullptr, nullptr) ||
      (client_pipe_flags & PIPE_REJECT_REMOTE_CLIENTS) == 0 ||
      (client_pipe_flags & PIPE_SERVER_END) != 0) {
    return Fail(
        "REMOTE_CLIENT_REJECTION_FAILED",
        "connected pipe does not report PIPE_REJECT_REMOTE_CLIENTS");
  }

  std::array<std::uint8_t, kTransportPreface.size()> preface{};
  DWORD input_error = ERROR_SUCCESS;
  if (ReadExactOverlapped(
          pipe.get(), preface.data(), static_cast<DWORD>(preface.size()),
          &input_error) != ReadResult::kOk ||
      preface != kTransportPreface) {
    return Fail(
        "TRANSPORT_PREFACE_FAILED",
        "server did not attest the hardened native transport protocol");
  }

  const std::string connected =
      ConnectedEvent("client", "serverPid", server_pid, current_user);
  if (!WriteFrame(GetStdHandle(STD_OUTPUT_HANDLE), connected, &input_error)) {
    return FailWindows(
        "CONTROL_CHANNEL_FAILED", "cannot write connected event", input_error);
  }
  (void)parent_pid;
  return RunRelay(pipe.get(), false);
}

std::wstring QuoteCommandLineArgument(std::wstring_view argument) {
  std::wstring quoted;
  quoted.push_back(L'"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

int SupervisorMain(const std::vector<std::wstring>& arguments) {
  const auto delimiter =
      std::find(arguments.begin(), arguments.end(), std::wstring(L"--"));
  if (delimiter == arguments.end() || std::next(delimiter) == arguments.end()) {
    return Fail(
        "INVALID_ARGUMENT",
        "supervise mode requires -- followed by an executable and arguments");
  }
  const std::vector<std::wstring> command(std::next(delimiter), arguments.end());
  if (command.front().empty()) {
    return Fail("INVALID_ARGUMENT", "supervised executable cannot be empty");
  }

  UniqueHandle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.valid()) {
    return FailWindows(
        "SUPERVISOR_JOB_FAILED", "cannot create Windows Job Object",
        GetLastError());
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          job.get(), JobObjectExtendedLimitInformation, &limits,
          sizeof(limits))) {
    return FailWindows(
        "SUPERVISOR_JOB_FAILED",
        "cannot configure kill-on-close process ownership", GetLastError());
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  for (const HANDLE standard_handle :
       {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
    if (standard_handle == nullptr || standard_handle == INVALID_HANDLE_VALUE ||
        !SetHandleInformation(
            standard_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
      return FailWindows(
          "SUPERVISOR_STDIO_FAILED",
          "cannot prepare inherited stdio handles", GetLastError());
    }
  }

  std::wstring command_line;
  for (const std::wstring& argument : command) {
    if (!command_line.empty()) {
      command_line.push_back(L' ');
    }
    command_line += QuoteCommandLineArgument(argument);
  }
  std::vector<wchar_t> mutable_command_line(
      command_line.begin(), command_line.end());
  mutable_command_line.push_back(L'\0');

  PROCESS_INFORMATION process_information{};
  if (!CreateProcessW(
          command.front().c_str(), mutable_command_line.data(), nullptr,
          nullptr, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, nullptr,
          &startup, &process_information)) {
    return FailWindows(
        "SUPERVISOR_LAUNCH_FAILED", "cannot launch supervised process",
        GetLastError());
  }
  UniqueHandle process(process_information.hProcess);
  UniqueHandle thread(process_information.hThread);
  if (!AssignProcessToJobObject(job.get(), process.get())) {
    const DWORD error = GetLastError();
    TerminateProcess(process.get(), 1);
    WaitForSingleObject(process.get(), 5000);
    return FailWindows(
        "SUPERVISOR_JOB_FAILED",
        "cannot assign supervised process to Windows Job Object", error);
  }
  if (ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateJobObject(job.get(), 1);
    WaitForSingleObject(process.get(), 5000);
    return FailWindows(
        "SUPERVISOR_LAUNCH_FAILED", "cannot resume supervised process",
        error);
  }

  if (WaitForSingleObject(process.get(), INFINITE) != WAIT_OBJECT_0) {
    const DWORD error = GetLastError();
    TerminateJobObject(job.get(), 1);
    return FailWindows(
        "SUPERVISOR_WAIT_FAILED", "cannot wait for supervised process",
        error);
  }
  DWORD exit_code = 1;
  if (!GetExitCodeProcess(process.get(), &exit_code)) {
    const DWORD error = GetLastError();
    TerminateJobObject(job.get(), 1);
    return FailWindows(
        "SUPERVISOR_WAIT_FAILED", "cannot read supervised process exit code",
        error);
  }

  // Closing the job is the authoritative cleanup boundary. Any geckodriver or
  // LibreWolf process still alive after the upstream Node process exits is
  // terminated by the kernel before the supervisor returns.
  thread.reset();
  process.reset();
  job.reset();
  return exit_code <= static_cast<DWORD>(std::numeric_limits<int>::max())
      ? static_cast<int>(exit_code)
      : 1;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    return Fail(
        "USAGE",
        "expected server, client, supervise, write-discovery, or "
        "remove-discovery mode");
  }
  const std::vector<std::wstring> arguments(argv + 2, argv + argc);
  const auto parent_pid = ParseProcessId(Argument(arguments, L"--parent-pid"));
  if (!parent_pid.has_value()) {
    return Fail("INVALID_ARGUMENT", "--parent-pid is required");
  }
  const auto current_user = CurrentUserSid();
  if (!current_user.has_value()) {
    return FailWindows(
        "CURRENT_USER_FAILED", "cannot read current process token",
        GetLastError());
  }
  UniqueHandle parent_process;
  std::string parent_error;
  if (!StartParentMonitor(
          parent_pid.value(), const_cast<std::uint8_t*>(current_user->data()),
          &parent_process, &parent_error)) {
    return Fail("PARENT_IDENTITY_FAILED", parent_error);
  }

  const std::wstring_view mode(argv[1]);
  if (mode == L"server") {
    return ServerMain(
        arguments, const_cast<std::uint8_t*>(current_user->data()),
        parent_pid.value());
  }
  if (mode == L"client") {
    return ClientMain(
        arguments, const_cast<std::uint8_t*>(current_user->data()),
        parent_pid.value());
  }
  if (mode == L"supervise") {
    return SupervisorMain(arguments);
  }
  if (mode == L"write-discovery") {
    return WriteDiscoveryMain(
        arguments, const_cast<std::uint8_t*>(current_user->data()));
  }
  if (mode == L"remove-discovery") {
    return RemoveDiscoveryMain(
        arguments, const_cast<std::uint8_t*>(current_user->data()));
  }
  return Fail(
      "USAGE",
      "mode must be server, client, supervise, write-discovery, or "
      "remove-discovery");
}
