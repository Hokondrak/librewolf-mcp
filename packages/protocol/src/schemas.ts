import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const BrowserModeSchema = z.enum(['controlled', 'companion']);
export type BrowserMode = z.infer<typeof BrowserModeSchema>;

export const PermissionCategorySchema = z.enum([
  'page-content',
  'interaction',
  'download',
  'upload',
  'clipboard-read',
  'sensitive-action',
]);
export type PermissionCategory = z.infer<typeof PermissionCategorySchema>;

export const PermissionEffectSchema = z.enum(['ask', 'allow', 'deny']);
export type PermissionEffect = z.infer<typeof PermissionEffectSchema>;

export const PermissionScopeSchema = z.enum(['once', 'session', 'always']);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

export const PermissionDecisionSchema = z.discriminatedUnion('effect', [
  z
    .object({
      effect: z.literal('ask'),
      reason: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      effect: z.enum(['allow', 'deny']),
      scope: PermissionScopeSchema,
      reason: z.string().min(1).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const CapabilityNameSchema = z.enum([
  'tabs',
  'navigation',
  'snapshot',
  'delta-snapshot',
  'interaction',
  'file-upload',
  'screenshot',
  'console',
  'network',
  'downloads',
  'batch',
  'highlight',
  'screen-recording',
]);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const CapabilityAvailabilitySchema = z.enum(['available', 'degraded', 'unavailable']);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const CapabilitySchema = z
  .object({
    name: CapabilityNameSchema,
    availability: CapabilityAvailabilitySchema,
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((capability, context) => {
    if (capability.availability !== 'available' && capability.reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A degraded or unavailable capability must include a reason.',
        path: ['reason'],
      });
    }
  });
export type Capability = z.infer<typeof CapabilitySchema>;

export const CapabilitiesSchema = z
  .object({
    browserMode: BrowserModeSchema,
    capabilities: z.array(CapabilitySchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const names = new Set<CapabilityName>();
    for (const [index, capability] of value.capabilities.entries()) {
      if (names.has(capability.name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate capability: ${capability.name}`,
          path: ['capabilities', index, 'name'],
        });
      }
      names.add(capability.name);
    }
  });
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const JsonRpcIdSchema = z.union([z.string(), z.number().int().safe(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.string().min(1).max(256),
    params: JsonValueSchema.optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1).max(256),
    params: JsonValueSchema.optional(),
  })
  .strict();
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const StructuredErrorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'PROTOCOL_MISMATCH',
  'AUTHENTICATION_FAILED',
  'REPLAY_DETECTED',
  'SEQUENCE_ERROR',
  'FRAME_TOO_LARGE',
  'MALFORMED_FRAME',
  'CAPABILITY_UNAVAILABLE',
  'PERMISSION_REQUIRED',
  'PERMISSION_DENIED',
  'INVALID_ORIGIN',
  'STALE_UID',
  'TAB_NOT_FOUND',
  'ELEMENT_NOT_FOUND',
  'ELEMENT_NOT_INTERACTABLE',
  'NAVIGATION_FAILED',
  'TIMEOUT',
  'CONNECTION_LOST',
  'INTERNAL_ERROR',
]);
export type StructuredErrorCode = z.infer<typeof StructuredErrorCodeSchema>;

export const StructuredErrorSchema = z
  .object({
    code: StructuredErrorCodeSchema,
    message: z.string().min(1).max(2_048),
    recoverable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().max(3_600_000).optional(),
    suggestedAction: z.string().min(1).max(1_024).optional(),
    details: JsonValueSchema.optional(),
  })
  .strict();
export type StructuredError = z.infer<typeof StructuredErrorSchema>;

export const JsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    result: JsonValueSchema,
  })
  .strict();
export type JsonRpcSuccess = z.infer<typeof JsonRpcSuccessSchema>;

export const JsonRpcErrorSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
        data: StructuredErrorSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessSchema,
  JsonRpcErrorSchema,
]);
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

const SessionIdSchema = z.string().uuid();
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const MacSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export const DiscoveryRecordSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    sessionId: SessionIdSchema,
    browserMode: BrowserModeSchema,
    transport: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('named-pipe'),
          endpoint: z.string().regex(/^\\\\\.\\pipe\\[^\\\u0000]+$/u),
        })
        .strict(),
      z
        .object({
          kind: z.literal('unix-socket'),
          endpoint: z
            .string()
            .min(1)
            .max(104)
            .refine((path) => !path.includes('\0'), {
              message: 'Socket path cannot contain NUL.',
            }),
        })
        .strict(),
    ]),
    ownerPid: z.number().int().positive(),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    tokenId: Base64UrlSchema.min(16).max(128),
    authTag: MacSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expiresAt must be after createdAt.',
        path: ['expiresAt'],
      });
    }
  });
export type DiscoveryRecord = z.infer<typeof DiscoveryRecordSchema>;

export const HandshakeRequestSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    sessionId: SessionIdSchema,
    clientName: z.string().min(1).max(128),
    clientNonce: Base64UrlSchema.min(22).max(128),
    tokenProof: MacSchema,
  })
  .strict();
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

export const HandshakeResponseSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    sessionId: SessionIdSchema,
    serverNonce: Base64UrlSchema.min(22).max(128),
    capabilities: CapabilitiesSchema,
    heartbeatIntervalMs: z.number().int().min(1_000).max(300_000),
    tokenProof: MacSchema,
  })
  .strict();
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

export const AuthenticatedFrameBodySchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    sessionId: SessionIdSchema,
    sequence: z.number().int().safe().nonnegative(),
    timestamp: z.string().datetime({ offset: true }),
    nonce: Base64UrlSchema.min(16).max(128),
    message: JsonRpcMessageSchema,
  })
  .strict();
export type AuthenticatedFrameBody = z.infer<typeof AuthenticatedFrameBodySchema>;

export const AuthenticatedFrameSchema = AuthenticatedFrameBodySchema.extend({
  mac: MacSchema,
}).strict();
export type AuthenticatedFrame = z.infer<typeof AuthenticatedFrameSchema>;
