import AnthropicFoundry from "@anthropic-ai/foundry-sdk";

export const client = new AnthropicFoundry({
  apiKey: process.env.AZURE_AI_API_KEY,
  resource: process.env.AZURE_AI_RESOURCE!,
});

export const MODEL = "claude-opus-4-6";
