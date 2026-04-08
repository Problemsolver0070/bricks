import AnthropicFoundry from "@anthropic-ai/foundry-sdk";

let _client: AnthropicFoundry | null = null;

export function getClient(): AnthropicFoundry {
  if (!_client) {
    if (!process.env.AZURE_AI_API_KEY || !process.env.AZURE_AI_RESOURCE) {
      throw new Error("Azure AI credentials not configured");
    }
    _client = new AnthropicFoundry({
      apiKey: process.env.AZURE_AI_API_KEY,
      resource: process.env.AZURE_AI_RESOURCE,
    });
  }
  return _client;
}

export const MODEL = "claude-opus-4-6";
