import type { Context } from "hono"

import { streamSSE, type SSEMessage } from "hono/streaming"

import type { ChatCompletionsPayload } from "~/services/copilot/chat-completions/types"
import type { ChatCompletionChunk } from "~/services/copilot/chat-completions/types-streaming"

import { logger } from "~/lib/logger"
import { chatCompletions } from "~/services/copilot/chat-completions/service"
import { chatCompletionsStream } from "~/services/copilot/chat-completions/service-streaming"

function createCondensedStreamingResponse(
  finalChunk: ChatCompletionChunk,
  collectedContent: string,
) {
  return {
    id: finalChunk.id,
    model: finalChunk.model,
    created: finalChunk.created,
    object: "chat.completion",
    system_fingerprint: finalChunk.system_fingerprint,
    usage: finalChunk.usage,
    choices: [
      {
        index: 0,
        finish_reason: finalChunk.choices[0].finish_reason,
        message: {
          role: "assistant",
          content: collectedContent,
        },
        content_filter_results: finalChunk.choices[0].content_filter_results,
      },
    ],
  }
}

export async function handlerStreaming(c: Context) {
  const payload = await c.req.json<ChatCompletionsPayload>()

  // Log the request at the beginning for both streaming and non-streaming cases
  await logger.logRequest("/chat/completions", "POST", payload)

  if (payload.stream) {
    const response = await chatCompletionsStream(payload)

    // For collecting the complete streaming response
    let collectedContent = ""
    let finalChunk: ChatCompletionChunk | null = null

    return streamSSE(c, async (stream) => {
      for await (const chunk of response) {
        const data = JSON.parse(chunk.data ?? "{}") as ChatCompletionChunk

        // Keep track of the latest chunk for metadata
        finalChunk = data

        // Accumulate content from each delta
        if (data.choices[0].delta.content) {
          collectedContent += data.choices[0].delta.content
        }

        await stream.writeSSE(chunk as SSEMessage)
      }

      // After streaming completes, log the condensed response
      if (finalChunk) {
        const condensedResponse = createCondensedStreamingResponse(
          finalChunk,
          collectedContent,
        )

        await logger.logResponse("/chat/completions", condensedResponse)
      }
    })
  }

  const response = await chatCompletions(payload)

  // Log the non-streaming response
  await logger.logResponse("/chat/completions", response)

  return c.json(response)
}
