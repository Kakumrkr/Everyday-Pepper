import { systemClock } from '@pepper/core';
import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { AiActionsController, AutonomyController } from './ai-actions.controller.js';
import { AiActionsService } from './ai-actions.service.js';
import { ChatController } from './chat.controller.js';
import {
  CHAT_CLOCK,
  CHAT_OPTIONS,
  ChatService,
  LLM_PROVIDER,
  llmProviderFor,
  type ChatOptions,
} from './chat.service.js';
import {
  ImportSuggestionsController,
  ImportSuggestionsService,
} from './import-suggestions.controller.js';
import { TurnEventLog } from './turn-events.js';
import { WinBackController, WinBackService } from './win-back.controller.js';

/**
 * Chat with the AI employee (ADR-0030), and its proposals, receipts and autonomy dial (S26,
 * ADR-0031), and the win-back list's drafts (S54.2), and the import mapping's suggestions (S56a.2). Needs `AuthModule` (global) and `ConnectionsModule`
 * (the database and Redis). Without an OpenAI key the AI is off: chat answers with its
 * fallback and every other screen works as before (AC-X-2).
 */
@Module({})
export class ChatModule {
  static forRoot(options: ChatOptions): DynamicModule {
    return {
      module: ChatModule,
      // Global: a card approved by text (S63, the SMS module) runs through `AiActionsService`.
      global: true,
      controllers: [
        ChatController,
        AiActionsController,
        AutonomyController,
        WinBackController,
        ImportSuggestionsController,
      ],
      providers: [
        { provide: CHAT_OPTIONS, useValue: options },
        { provide: LLM_PROVIDER, useFactory: () => llmProviderFor(options) },
        { provide: CHAT_CLOCK, useValue: systemClock },
        ChatService,
        AiActionsService,
        WinBackService,
        ImportSuggestionsService,
        TurnEventLog,
        RateLimiter,
      ],
      // `ChatService`: the team's no-show proposes the fee card with the AI's deps (S68).
      exports: [AiActionsService, ChatService],
    };
  }
}
