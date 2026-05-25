/**
 * Public surface of the model layer.
 *
 * Agent nodes import from `@/lib/models` — never from the provider files
 * directly. The router is the ONLY thing that touches Anthropic + Ollama.
 */
export { router, ModelRouter, type StreamChunk } from "./router";
export type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  LoggedPurpose,
  Message,
  Provider,
  Purpose,
  Role,
  StreamResult,
} from "./types";
export {
  DailyCapExceeded,
  NoProviderAvailable,
  ProviderError,
  RouterError,
  isRouterError,
} from "./errors";
export type { CostLedger, LedgerSnapshot } from "./cost-ledger";
export { MemoryCostLedger, defaultCostLedger } from "./cost-ledger";
export type { CallLog, ModelCallRow } from "./call-log";
export { ConsoleCallLog, NoopCallLog, defaultCallLog } from "./call-log";
export { costOfCall, estimateCallCost, estimateInputTokens, KNOWN_ANTHROPIC_MODELS } from "./pricing";
