import type { PermissionCategory } from '@librewolf-agent-bridge/protocol';

export type OperationRisk = 'none' | 'read' | 'write' | 'sensitive' | 'destructive';

export interface OperationRiskDescriptor {
  readonly risk: OperationRisk;
  readonly permissions: readonly PermissionCategory[];
  readonly readOnly: boolean;
  readonly stateChanging: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly requiresUserConfirmation: boolean;
}

const operationRiskRegistry = {
  browser_status: ['none', [], true, false, false, true, false],
  browser_list_tabs: ['read', ['page-content'], true, false, false, true, false],
  browser_select_tab: ['write', ['interaction'], false, true, false, true, false],
  browser_open_tab: ['write', ['interaction'], false, true, false, false, false],
  browser_close_tab: ['destructive', ['sensitive-action'], false, true, true, true, true],
  browser_navigate: ['write', ['interaction'], false, true, false, false, false],
  browser_back: ['write', ['interaction'], false, true, false, false, false],
  browser_forward: ['write', ['interaction'], false, true, false, false, false],
  browser_snapshot: ['read', ['page-content'], true, false, false, true, false],
  browser_find: ['read', ['page-content'], true, false, false, true, false],
  browser_get_text: ['read', ['page-content'], true, false, false, true, false],
  browser_click: ['write', ['interaction'], false, true, false, false, false],
  browser_hover: ['write', ['interaction'], false, true, false, true, false],
  browser_fill: ['sensitive', ['interaction'], false, true, false, false, false],
  browser_fill_form: ['sensitive', ['interaction'], false, true, false, false, false],
  browser_select_option: ['write', ['interaction'], false, true, false, false, false],
  browser_press_key: ['write', ['interaction'], false, true, false, false, false],
  browser_scroll: ['write', ['interaction'], false, true, false, false, false],
  browser_upload_file: ['sensitive', ['upload'], false, true, false, false, true],
  browser_screenshot: ['read', ['page-content'], true, false, false, true, false],
  browser_get_console: ['read', ['page-content'], true, false, false, true, false],
  browser_get_network: ['sensitive', ['page-content'], true, false, false, true, false],
  browser_get_request: ['sensitive', ['page-content'], true, false, false, true, false],
  browser_get_downloads: ['sensitive', ['download'], true, false, false, true, false],
  browser_batch: ['sensitive', ['sensitive-action'], false, true, false, false, true],
} as const satisfies Record<
  string,
  readonly [
    OperationRisk,
    readonly PermissionCategory[],
    boolean,
    boolean,
    boolean,
    boolean,
    boolean,
  ]
>;

export type BrowserOperation = keyof typeof operationRiskRegistry;

export const OPERATION_RISK_REGISTRY: Readonly<Record<BrowserOperation, OperationRiskDescriptor>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(operationRiskRegistry).map(([operation, values]) => [
        operation,
        Object.freeze({
          risk: values[0],
          permissions: Object.freeze([...values[1]]),
          readOnly: values[2],
          stateChanging: values[3],
          destructive: values[4],
          idempotent: values[5],
          requiresUserConfirmation: values[6],
        }),
      ]),
    ) as Record<BrowserOperation, OperationRiskDescriptor>,
  );

export const getOperationRisk = (operation: string): OperationRiskDescriptor | undefined =>
  Object.hasOwn(OPERATION_RISK_REGISTRY, operation)
    ? OPERATION_RISK_REGISTRY[operation as BrowserOperation]
    : undefined;
