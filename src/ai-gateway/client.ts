/**
 * Cloudflare AI Gateway client
 *
 * OpenAI-compatible chat completions routed through AI Gateway.
 * Supports Dynamic Routing and BYOK — no provider keys in requests.
 *
 * Shaped for Azure OpenAI GPT-5.4 reasoning models:
 * - Uses "developer" role (not "system")
 * - Uses max_completion_tokens (not max_tokens)
 * - Supports reasoning_effort parameter
 * - temperature fixed at 1 (GPT-5 default)
 */

import { getConfig } from '../config.js';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatMessage {
  role: 'developer' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  max_completion_tokens?: number;
  reasoning_effort?: ReasoningEffort;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function isAiGatewayConfigured(): boolean {
  const config = getConfig();
  return !!(config.aiGatewayEndpoint && config.aiGatewayToken && config.aiGatewayModel);
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<ChatCompletionResult> {
  const config = getConfig();

  if (!config.aiGatewayEndpoint || !config.aiGatewayToken) {
    throw new Error('AI Gateway not configured: set CF_AI_GATEWAY_ENDPOINT and CF_AIG_TOKEN');
  }

  const model = options.model ?? config.aiGatewayModel;
  if (!model) {
    throw new Error('AI Gateway model not configured: set CF_AI_GATEWAY_MODEL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiGatewayTimeoutMs);

  try {
    const response = await fetch(config.aiGatewayEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-aig-authorization': `Bearer ${config.aiGatewayToken}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 1,
        ...(options.max_completion_tokens
          ? { max_completion_tokens: options.max_completion_tokens }
          : {}),
        ...(options.reasoning_effort
          ? { reasoning_effort: options.reasoning_effort }
          : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI Gateway request failed (${response.status}): ${text}`);
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[];
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error('AI Gateway returned empty response');
    }

    return {
      content: choice.message.content,
      model: data.model,
      usage: data.usage,
    };
  } finally {
    clearTimeout(timeout);
  }
}
