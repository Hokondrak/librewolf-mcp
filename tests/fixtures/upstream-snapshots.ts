/**
 * Raw upstream snapshot text as `@mozilla/firefox-devtools-mcp@0.9.15` formats it on
 * LibreWolf 146.0-2, including the tag-based `input` roles recorded in COMPATIBILITY.md.
 * Integration tests assert that the bridge normalizes this text rather than relaying it.
 */
export const accountFormSnapshot = `📸 Snapshot (id=1)

uid=1_0 form
  uid=1_1 heading "Account settings" text="Account settings"
  uid=1_2 input "Email" value="max@example.test" focusable interactive name="email"
  uid=1_3 input "Password" value="fixture-password" focusable interactive name="password" type="password"
  uid=1_4 button "Save" text="Save" focusable interactive
  uid=1_5 link "Cancel" text="Cancel" focusable interactive
`;

/** The same document after a DOM mutation that adds a status line and removes the link. */
export const accountFormAfterSaveSnapshot = `📸 Snapshot (id=2)

uid=2_0 form
  uid=2_1 heading "Account settings" text="Account settings"
  uid=2_2 input "Email" value="max@example.test" focusable interactive name="email"
  uid=2_3 input "Password" value="fixture-password" focusable interactive name="password" type="password"
  uid=2_4 button "Save" text="Save" focusable interactive
  uid=2_5 status "Saved" text="Saved"
`;

/** A snapshot on a different document, used to prove navigation invalidates prior UIDs. */
export const secondDocumentSnapshot = `📸 Snapshot (id=3)

uid=3_0 main
  uid=3_1 heading "Second document" text="Second document"
`;
