"use client";

import { useCallback, useState, DragEvent, useRef } from "react";
import { Upload, FileText } from "lucide-react";

interface Props {
  file: File | null;
  onFileSelect: (file: File) => void;
}

export default function FileUploader({ file, onFileSelect }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (f: File) => {
    if (f.name.toLowerCase().endsWith(".txt")) onFileSelect(f);
  };

  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  }, [onFileSelect]);

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onClick={() => inputRef.current?.click()}
      className={`
        relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer
        transition-all duration-150 select-none
        ${dragging
          ? "border-green-400 bg-green-50"
          : file
          ? "border-green-300 bg-green-50/40"
          : "border-gray-200 bg-gray-50 hover:border-green-300 hover:bg-green-50/30"
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".txt"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) accept(f); }}
      />

      {file ? (
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-green-100 rounded-2xl flex items-center justify-center">
            <FileText className="w-7 h-7 text-green-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">{file.name}</p>
            <p className="text-sm text-gray-400 mt-0.5">
              {(file.size / 1024).toFixed(1)} KB · click to change
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-white border border-gray-200 rounded-2xl flex items-center justify-center shadow-sm">
            <Upload className="w-7 h-7 text-gray-400" />
          </div>
          <div>
            <p className="font-semibold text-gray-700">
              {dragging ? "Drop it here" : "Drop your .txt export"}
            </p>
            <p className="text-sm text-gray-400 mt-0.5">or click to browse</p>
          </div>
          <p className="text-xs text-gray-300 mt-1">WhatsApp → Settings → Chats → Export Chat → Without Media</p>
        </div>
      )}
    </div>
  );
}
