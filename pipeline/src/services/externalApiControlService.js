const { config } = require("../config/env");
const { appendPipelineEvent } = require("./pipelineEventLogService");

const PROVIDERS = ["openai", "gemini", "youtube"];
const countersByExecution = new Map();

const getExecutionKey = (videoId = "") => String(videoId || "global");

const makeEmptyCounters = () => ({
  total_calls: 0,
  openai_calls: 0,
  gemini_calls: 0,
  youtube_calls: 0,
  blocked_calls: 0,
  fallbacks_used: 0,
  last_updated_at: "",
});

const getCounters = (videoId = "") => {
  const key = getExecutionKey(videoId);
  if (!countersByExecution.has(key)) {
    countersByExecution.set(key, makeEmptyCounters());
  }
  return countersByExecution.get(key);
};

const isProviderDisabledInLocalTest = (provider = "") => {
  if (!config.LOCAL_TEST_MODE) return false;
  if (provider === "openai") return config.LOCAL_TEST_DISABLE_OPENAI === true;
  if (provider === "gemini") return config.LOCAL_TEST_DISABLE_GEMINI === true;
  if (provider === "youtube") return config.LOCAL_TEST_DISABLE_YOUTUBE === true;
  return false;
};

const readProviderLimit = (provider = "") => {
  if (provider === "openai") return Number(config.EXTERNAL_API_MAX_CALLS_OPENAI || -1);
  if (provider === "gemini") return Number(config.EXTERNAL_API_MAX_CALLS_GEMINI || -1);
  if (provider === "youtube") return Number(config.EXTERNAL_API_MAX_CALLS_YOUTUBE || -1);
  return -1;
};

const isCircuitBreakerEnabled = () =>
  config.EXTERNAL_API_CIRCUIT_BREAKER_ENABLED === true || config.LOCAL_TEST_MODE === true;

const appendBlockedEvent = ({ videoId = "", provider = "", operation = "", reason = "", counters = {} }) => {
  if (!videoId) return;
  appendPipelineEvent({
    videoId,
    stage: "external_api",
    event: "blocked",
    status: "warn",
    payload: {
      provider,
      operation,
      reason,
      counters,
    },
  }).catch(() => null);
};

const consumeExternalCallBudget = ({
  provider = "",
  videoId = "",
  operation = "",
} = {}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const counters = getCounters(videoId);
  counters.last_updated_at = new Date().toISOString();

  if (!PROVIDERS.includes(normalizedProvider)) {
    return {
      allowed: false,
      reason: "provider_not_supported",
      counters: { ...counters },
    };
  }

  if (isProviderDisabledInLocalTest(normalizedProvider)) {
    counters.blocked_calls += 1;
    appendBlockedEvent({
      videoId,
      provider: normalizedProvider,
      operation,
      reason: "provider_disabled_local_test_mode",
      counters,
    });
    return {
      allowed: false,
      reason: "provider_disabled_local_test_mode",
      counters: { ...counters },
    };
  }

  if (!isCircuitBreakerEnabled()) {
    counters.total_calls += 1;
    counters[`${normalizedProvider}_calls`] += 1;
    return {
      allowed: true,
      reason: "",
      counters: { ...counters },
    };
  }

  const totalLimit = Number(config.EXTERNAL_API_MAX_CALLS_TOTAL || -1);
  const providerLimit = readProviderLimit(normalizedProvider);

  if (totalLimit >= 0 && counters.total_calls >= totalLimit) {
    counters.blocked_calls += 1;
    appendBlockedEvent({
      videoId,
      provider: normalizedProvider,
      operation,
      reason: "external_total_budget_exceeded",
      counters,
    });
    return {
      allowed: false,
      reason: "external_total_budget_exceeded",
      counters: { ...counters },
    };
  }

  const providerKey = `${normalizedProvider}_calls`;
  if (providerLimit >= 0 && Number(counters[providerKey] || 0) >= providerLimit) {
    counters.blocked_calls += 1;
    appendBlockedEvent({
      videoId,
      provider: normalizedProvider,
      operation,
      reason: `${normalizedProvider}_budget_exceeded`,
      counters,
    });
    return {
      allowed: false,
      reason: `${normalizedProvider}_budget_exceeded`,
      counters: { ...counters },
    };
  }

  counters.total_calls += 1;
  counters[providerKey] += 1;
  return {
    allowed: true,
    reason: "",
    counters: { ...counters },
  };
};

const registerFallback = ({ videoId = "", provider = "", reason = "", operation = "" } = {}) => {
  const counters = getCounters(videoId);
  counters.last_updated_at = new Date().toISOString();
  counters.fallbacks_used += 1;
  if (!videoId) return { ...counters };
  appendPipelineEvent({
    videoId,
    stage: "external_api",
    event: "fallback",
    status: "warn",
    payload: {
      provider: String(provider || ""),
      operation: String(operation || ""),
      reason: String(reason || "fallback_used"),
      counters: { ...counters },
    },
  }).catch(() => null);
  return { ...counters };
};

const getExternalApiStats = ({ videoId = "" } = {}) => ({ ...getCounters(videoId) });

module.exports = {
  consumeExternalCallBudget,
  registerFallback,
  getExternalApiStats,
  isProviderDisabledInLocalTest,
};
