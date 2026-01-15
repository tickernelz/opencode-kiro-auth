import * as crypto from 'crypto';
import * as os from 'os';
import type { KiroAuthDetails, PreparedRequest, CodeWhispererMessage, CodeWhispererRequest } from './types';
import { KIRO_CONSTANTS } from '../constants';
import { resolveKiroModel } from './models';

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
    tool_use_id?: string;
    id?: string;
    name?: string;
    input?: unknown;
    thinking?: string;
    source?: { media_type: string; data: string };
  }>;
}

interface OpenAITool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface OpenAIRequest {
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
}

export function transformToCodeWhisperer(
  url: string,
  body: string,
  model: string,
  auth: KiroAuthDetails,
  thinkingEnabled: boolean = false
): PreparedRequest {
  const openAIRequest: OpenAIRequest = JSON.parse(body);
  const { messages, tools, system: systemPrompt } = openAIRequest;

  if (!messages || messages.length === 0) {
    throw new Error('No messages found in request');
  }

  const resolvedModel = resolveKiroModel(model);
  const conversationId = crypto.randomUUID();

  let processedSystemPrompt = systemPrompt || '';
  if (thinkingEnabled) {
    const thinkingPrefix = '<thinking_mode>enabled</thinking_mode><max_thinking_length>20000</max_thinking_length>';
    if (!processedSystemPrompt) {
      processedSystemPrompt = thinkingPrefix;
    } else if (!processedSystemPrompt.includes('<thinking_mode>')) {
      processedSystemPrompt = `${thinkingPrefix}\n${processedSystemPrompt}`;
    }
  }

  let processedMessages = [...messages];

  const lastMessage = processedMessages[processedMessages.length - 1];
  if (lastMessage?.role === 'assistant') {
    const content = getContentText(lastMessage);
    if (content === '{') {
      processedMessages.pop();
    }
  }

  processedMessages = mergeAdjacentMessages(processedMessages);

  const codewhispererTools = tools ? convertToolsToCodeWhisperer(tools) : [];

  const history: CodeWhispererMessage[] = [];
  let startIndex = 0;

  if (processedSystemPrompt) {
    if (processedMessages[0]?.role === 'user') {
      const firstUserContent = getContentText(processedMessages[0]);
      history.push({
        userInputMessage: {
          content: `${processedSystemPrompt}\n\n${firstUserContent}`,
          modelId: resolvedModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
        }
      });
      startIndex = 1;
    } else {
      history.push({
        userInputMessage: {
          content: processedSystemPrompt,
          modelId: resolvedModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
        }
      });
    }
  }

  const keepImageThreshold = 5;
  for (let i = startIndex; i < processedMessages.length - 1; i++) {
    const message = processedMessages[i];
    if (!message) continue;
    
    const distanceFromEnd = (processedMessages.length - 1) - i;
    const shouldKeepImages = distanceFromEnd <= keepImageThreshold;

    if (message.role === 'user') {
      const userInputMessage: any = {
        content: '',
        modelId: resolvedModel,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      };
      let imageCount = 0;
      const toolResults: any[] = [];
      const images: any[] = [];

      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text') {
            userInputMessage.content += part.text || '';
          } else if (part.type === 'tool_result') {
            toolResults.push({
              content: [{ text: getContentText(part) }],
              status: 'success',
              toolUseId: part.tool_use_id
            });
          } else if (part.type === 'image') {
            if (shouldKeepImages && part.source) {
              images.push({
                format: part.source.media_type?.split('/')[1] || 'png',
                source: {
                  bytes: part.source.data
                }
              });
            } else {
              imageCount++;
            }
          }
        }
      } else {
        userInputMessage.content = getContentText(message);
      }

      if (images.length > 0) {
        userInputMessage.images = images;
      }

      if (imageCount > 0) {
        const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
        userInputMessage.content = userInputMessage.content
          ? `${userInputMessage.content}\n${imagePlaceholder}`
          : imagePlaceholder;
      }

      if (toolResults.length > 0) {
        const uniqueToolResults = deduplicateToolResults(toolResults);
        userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
      }

      history.push({ userInputMessage });
    } else if (message.role === 'assistant') {
      const assistantResponseMessage: any = {
        content: ''
      };
      const toolUses: any[] = [];
      let thinkingText = '';

      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text') {
            assistantResponseMessage.content += part.text || '';
          } else if (part.type === 'thinking') {
            thinkingText += (part.thinking || part.text || '');
          } else if (part.type === 'tool_use') {
            toolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            });
          }
        }
      } else {
        assistantResponseMessage.content = getContentText(message);
      }

      if (thinkingText) {
        assistantResponseMessage.content = assistantResponseMessage.content
          ? `<thinking>${thinkingText}</thinking>\n\n${assistantResponseMessage.content}`
          : `<thinking>${thinkingText}</thinking>`;
      }

      if (toolUses.length > 0) {
        assistantResponseMessage.toolUses = toolUses;
      }

      history.push({ assistantResponseMessage });
    }
  }

  const currentMessage = processedMessages[processedMessages.length - 1];
  if (!currentMessage) {
    throw new Error('No current message found');
  }
  
  let currentContent = '';
  const currentToolResults: any[] = [];
  const currentImages: any[] = [];

  if (currentMessage.role === 'assistant') {
    const assistantResponseMessage: any = {
      content: ''
    };
    const toolUses: any[] = [];
    let thinkingText = '';

    if (Array.isArray(currentMessage.content)) {
      for (const part of currentMessage.content) {
        if (part.type === 'text') {
          assistantResponseMessage.content += part.text || '';
        } else if (part.type === 'thinking') {
          thinkingText += (part.thinking || part.text || '');
        } else if (part.type === 'tool_use') {
          toolUses.push({
            input: part.input,
            name: part.name,
            toolUseId: part.id
          });
        }
      }
    } else {
      assistantResponseMessage.content = getContentText(currentMessage);
    }

    if (thinkingText) {
      assistantResponseMessage.content = assistantResponseMessage.content
        ? `<thinking>${thinkingText}</thinking>\n\n${assistantResponseMessage.content}`
        : `<thinking>${thinkingText}</thinking>`;
    }

    if (toolUses.length > 0) {
      assistantResponseMessage.toolUses = toolUses;
    }

    history.push({ assistantResponseMessage });
    currentContent = 'Continue';
  } else {
    if (history.length > 0) {
      const lastHistoryItem = history[history.length - 1];
      if (lastHistoryItem && !lastHistoryItem.assistantResponseMessage) {
        history.push({
          assistantResponseMessage: {
            content: 'Continue'
          }
        });
      }
    }

    if (Array.isArray(currentMessage.content)) {
      for (const part of currentMessage.content) {
        if (part.type === 'text') {
          currentContent += part.text || '';
        } else if (part.type === 'tool_result') {
          currentToolResults.push({
            content: [{ text: getContentText(part) }],
            status: 'success',
            toolUseId: part.tool_use_id
          });
        } else if (part.type === 'image') {
          if (part.source) {
            currentImages.push({
              format: part.source.media_type?.split('/')[1] || 'png',
              source: {
                bytes: part.source.data
              }
            });
          }
        }
      }
    } else {
      currentContent = getContentText(currentMessage);
    }

    if (!currentContent) {
      currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
    }
  }

  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: conversationId,
      history: history.length > 0 ? history : [],
      currentMessage: {
        userInputMessage: {
          content: currentContent,
          modelId: resolvedModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      }
    }
  };

  if (history.length === 0) {
    delete (request.conversationState as any).history;
  }

  const userInputMessage = request.conversationState.currentMessage.userInputMessage!;

  if (currentImages.length > 0) {
    userInputMessage.images = currentImages;
  }

  const userInputMessageContext: any = {};
  if (currentToolResults.length > 0) {
    const uniqueToolResults = deduplicateToolResults(currentToolResults);
    userInputMessageContext.toolResults = uniqueToolResults;
  }
  if (codewhispererTools.length > 0) {
    userInputMessageContext.tools = codewhispererTools;
  }

  if (Object.keys(userInputMessageContext).length > 0) {
    userInputMessage.userInputMessageContext = userInputMessageContext;
  }

  if (auth.authMethod === 'social' && auth.profileArn) {
    request.profileArn = auth.profileArn;
  }

  const finalUrl = KIRO_CONSTANTS.BASE_URL.replace('{{region}}', auth.region);
  const machineId = generateMachineId(auth);
  const userAgent = buildUserAgent(machineId);

  return {
    url: finalUrl,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.access}`,
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': `aws-sdk-js/1.0.0 ${userAgent}`,
        'user-agent': userAgent
      },
      body: JSON.stringify(request)
    },
    streaming: true,
    effectiveModel: resolvedModel,
    conversationId: conversationId
  };
}

export function mergeAdjacentMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const merged: OpenAIMessage[] = [];

  for (const currentMsg of messages) {
    if (merged.length === 0) {
      merged.push({ ...currentMsg });
    } else {
      const lastMsg = merged[merged.length - 1];
      if (!lastMsg) continue;

      if (currentMsg.role === lastMsg.role) {
        if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
          lastMsg.content.push(...currentMsg.content);
        } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
          lastMsg.content += '\n' + currentMsg.content;
        } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
          lastMsg.content.push({ type: 'text', text: currentMsg.content });
        } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
          lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
        }
      } else {
        merged.push({ ...currentMsg });
      }
    }
  }

  return merged;
}

export function convertToolsToCodeWhisperer(tools: OpenAITool[]): any[] {
  const MAX_DESCRIPTION_LENGTH = 9216;

  const filteredTools = tools.filter(tool => {
    const name = (tool.name || '').toLowerCase();
    return name !== 'web_search' && name !== 'websearch';
  });

  return filteredTools.map(tool => {
    let desc = tool.description || '';
    if (desc.length > MAX_DESCRIPTION_LENGTH) {
      desc = desc.substring(0, MAX_DESCRIPTION_LENGTH) + '...';
    }

    return {
      toolSpecification: {
        name: tool.name,
        description: desc,
        inputSchema: {
          json: tool.input_schema || {}
        }
      }
    };
  });
}

export function extractImagesFromContent(content: any): { text: string; images: any[] } {
  const images: any[] = [];
  let text = '';

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') {
        text += part.text || '';
      } else if (part.type === 'image' && part.source) {
        images.push({
          format: part.source.media_type?.split('/')[1] || 'png',
          source: {
            bytes: part.source.data
          }
        });
      }
    }
  } else if (typeof content === 'string') {
    text = content;
  }

  return { text, images };
}

export function buildUserAgent(machineId: string): string {
  const platform = os.platform();
  const nodeVersion = process.version.replace('v', '');
  const arch = os.arch();

  return `KiroIDE-${KIRO_CONSTANTS.KIRO_VERSION}-${machineId} ua/2.1 os/${platform} lang/js md/nodejs#${nodeVersion} api/codewhisperer#1.0.0 exec-env/${arch}`;
}

export function generateMachineId(auth: KiroAuthDetails): string {
  const source = auth.profileArn || auth.clientId || 'default';
  return crypto.createHash('sha256').update(source).digest('hex').substring(0, 16);
}

function getContentText(message: any): string {
  if (typeof message === 'string') {
    return message;
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text || '')
      .join('');
  }
  if (message.text) {
    return message.text;
  }
  return '';
}

function deduplicateToolResults(toolResults: any[]): any[] {
  const unique: any[] = [];
  const seenIds = new Set<string>();

  for (const tr of toolResults) {
    if (!seenIds.has(tr.toolUseId)) {
      seenIds.add(tr.toolUseId);
      unique.push(tr);
    }
  }

  return unique;
}
