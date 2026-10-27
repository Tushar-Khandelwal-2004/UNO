"use client";

import type { QuickMessage } from "@uno/protocol";

const MESSAGES: QuickMessage[] = ["Nice!", "Dang!", "GG", "Hurry up!", "Oops", "Wow!", "Your turn", "Good game"];

export function QuickMessagePicker({ onChoose }: { onChoose: (message: QuickMessage) => void }) {
  return (
    <div className="quick-message-picker" role="dialog" aria-label="Quick messages">
      {MESSAGES.map((message) => <button key={message} type="button" onClick={() => onChoose(message)}>{message}</button>)}
    </div>
  );
}
