"use client";

import { Mic, ImageIcon, FileText, File, Info, Video, RefreshCw, Users, Calendar, MessageSquare } from "lucide-react";

interface ParseStats {
  total_messages: number;
  non_system: number;
  system: number;
  voice_notes: number;
  images: number;
  participants: string[];
  date_from: string | null;
  date_to: string | null;
  parse_errors: number;
  total_lines: number;
}

interface ParsedMessage {
  position: number;
  timestamp: string;
  sender: string | null;
  body: string;
  message_type: string;
  media_filename: string | null;
  burst_id: number | null;
}

interface ParseResponse {
  filename: string;
  format_detected: string;
  stats: ParseStats;
  preview_capped: boolean;
  messages: ParsedMessage[];
}

const SENDER_COLORS = [
  "text-green-700",
  "text-blue-700",
  "text-purple-700",
  "text-orange-700",
  "text-pink-700",
  "text-teal-700",
];

function senderColor(sender: string, participants: string[]) {
  const idx = participants.indexOf(sender);
  return SENDER_COLORS[idx % SENDER_COLORS.length];
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function isArabic(text: string) {
  return /[؀-ۿ]/.test(text);
}

function TypeIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 inline-block mr-1 opacity-60 shrink-0";
  switch (type) {
    case "voice":    return <Mic      className={cls} />;
    case "image":    return <ImageIcon className={cls} />;
    case "video":    return <Video    className={cls} />;
    case "pdf":      return <FileText className={cls} />;
    case "document": return <File     className={cls} />;
    case "system":   return <Info     className={cls} />;
    default:         return null;
  }
}

interface Props {
  result: ParseResponse;
  onReset: () => void;
}

export default function ParseResult({ result, onReset }: Props) {
  const { filename, format_detected, stats, messages, preview_capped } = result;

  return (
    <div className="flex flex-col gap-5">

      {/* Header bar */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-green-100 rounded-lg flex items-center justify-center">
            <FileText className="w-5 h-5 text-green-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm">{filename}</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Parsed successfully ·{" "}
              <span className="capitalize font-medium text-gray-500">{format_detected}</span> format
              {stats.parse_errors > 0 && (
                <span className="text-amber-500 ml-2">{stats.parse_errors} skipped lines</span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Upload another
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          icon={<MessageSquare className="w-4 h-4 text-green-500" />}
          label="Messages"
          value={stats.non_system.toLocaleString()}
        />
        <StatCard
          icon={<Users className="w-4 h-4 text-blue-500" />}
          label={stats.participants.length === 1 ? "Participant" : "Participants"}
          value={stats.participants.length.toString()}
          sub={stats.participants.slice(0, 2).join(", ") + (stats.participants.length > 2 ? "…" : "")}
        />
        <StatCard
          icon={<Mic className="w-4 h-4 text-purple-500" />}
          label="Voice notes"
          value={stats.voice_notes.toString()}
        />
        <StatCard
          icon={<Calendar className="w-4 h-4 text-orange-500" />}
          label="Date range"
          value={formatDate(stats.date_from)}
          sub={stats.date_to ? `→ ${formatDate(stats.date_to)}` : ""}
        />
      </div>

      {/* Message preview */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-sm text-gray-700">
            Message preview
          </h2>
          {preview_capped && (
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              First 500 shown
            </span>
          )}
        </div>

        <div className="divide-y divide-gray-50 max-h-[520px] overflow-y-auto">
          {messages.map((msg) => {
            if (msg.message_type === "system") {
              return (
                <div key={msg.position} className="px-5 py-2 flex justify-center">
                  <span className="text-xs text-gray-400 bg-gray-50 px-3 py-1 rounded-full">
                    <Info className="w-3 h-3 inline mr-1 opacity-50" />
                    {msg.body}
                  </span>
                </div>
              );
            }

            const arabic = isArabic(msg.body);
            const color  = senderColor(msg.sender!, stats.participants);

            return (
              <div key={msg.position} className="px-5 py-3 flex gap-3 hover:bg-gray-50/60 transition-colors">
                {/* Time */}
                <span className="text-xs text-gray-300 mt-0.5 w-12 shrink-0 tabular-nums">
                  {formatTime(msg.timestamp)}
                </span>

                {/* Bubble */}
                <div className="flex-1 min-w-0">
                  <span className={`text-xs font-semibold ${color} mr-2`}>
                    {msg.sender}
                  </span>
                  <p
                    dir={arabic ? "rtl" : "ltr"}
                    className={`text-sm text-gray-700 mt-0.5 break-words ${arabic ? "font-arabic" : ""}`}
                  >
                    <TypeIcon type={msg.message_type} />
                    {msg.message_type !== "text" && msg.media_filename
                      ? <span className="italic text-gray-400">{msg.media_filename}</span>
                      : msg.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

function StatCard({
  icon, label, value, sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs text-gray-400 uppercase tracking-wide font-medium">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900 leading-none">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1 truncate">{sub}</p>}
    </div>
  );
}
