const axios = require("axios");
const { config } = require("../config/env");

const postToWebhookIfConfigured = async ({ url, payload }) => {
  if (!url) {
    return { triggered: false, configured: false, message: "Webhook não configurado" };
  }

  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    timeout: 45000,
  });

  return {
    triggered: true,
    configured: true,
    status: response.status,
    data: response.data,
  };
};

const triggerWorkflow2 = async (payload) => {
  return postToWebhookIfConfigured({
    url: config.N8N_WORKFLOW_2_WEBHOOK,
    payload,
  });
};

const triggerWorkflow3 = async (payload) => {
  return postToWebhookIfConfigured({
    url: config.N8N_WORKFLOW_3_WEBHOOK,
    payload,
  });
};

module.exports = {
  triggerWorkflow2,
  triggerWorkflow3,
};