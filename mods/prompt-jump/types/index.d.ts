// UserMessage 행의 requestId (transcript 메시지 id)
export type MessageId = string

// 목록 한 줄: 이동할 메시지 id와 프롬프트 원문
export type PromptEntry = { id: MessageId; text: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-jump': {
      // 패널 검색어
      filter: string
      // 마지막으로 이동한 메시지 (목록에서 강조)
      current: MessageId
      // /jump를 열 때 계산한 현재 대화의 프롬프트 (오래된 → 최신)
      entries: PromptEntry[]
    }
  }
}
