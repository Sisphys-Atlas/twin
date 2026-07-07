"use client";

interface Props {
  sender: string;
  body: string;
  timestamp: string;
  direction?: "ltr" | "rtl";
}

// Milestone 4: individual message display with citation highlighting
export default function MessageBubble({ sender, body, timestamp, direction = "ltr" }: Props) {
  return (
    <div dir={direction} className="p-3 rounded-lg bg-white shadow-sm text-sm">
      <span className="font-semibold">{sender}</span>
      <span className="text-gray-400 ml-2 text-xs">{timestamp}</span>
      <p className="mt-1">{body}</p>
    </div>
  );
}
