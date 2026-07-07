"""Quick smoke-test for the parser — no external dependencies."""
import sys
sys.path.insert(0, ".")
from app.parsing.whatsapp_parser import parse

ANDROID_EN = """\
12/25/2023, 3:45 PM - Ahmed: Hello there
12/25/2023, 3:45 PM - Ahmed: How are you doing?
12/25/2023, 3:46 PM - Sara: I am fine, thanks!
12/25/2023, 3:47 PM - Ahmed: PTT-20231225-WA0001.opus (file attached)
12/25/2023, 3:48 PM - Sara: <Media omitted>
12/25/2023, 3:48 PM - Messages and calls are end-to-end encrypted.
12/25/2023, 3:50 PM - Ahmed: Multi-line message
second line here
third line
12/25/2023, 3:51 PM - Sara: IMG-20231225-WA0001.jpg (file attached)
"""

IOS_EN = """\
[12/25/23, 3:45:22 PM] Ahmed: Bonjour
[12/25/23, 3:46:01 PM] Sara: Salut!
[12/25/23, 3:46:30 PM] Ahmed: document.pdf (file attached)
"""

ANDROID_AR = """\
25/12/2023، 15:45 - Ahmed: مرحبا
25/12/2023، 15:46 - Sara: كيف حالك؟
25/12/2023، 15:47 - Ahmed: بخير شكرا
"""

ARABIC_INDIC = """\
٢٥/١٢/٢٠٢٣, ١٥:٤٥ - Ahmed: Arabic numerals test
٢٥/١٢/٢٠٢٣, ١٥:٤٦ - Sara: Reply
"""

failures = []

def check(label, condition, detail=""):
    if condition:
        print(f"  [OK]   {label}")
    else:
        print(f"  [FAIL] {label}" + (f": {detail}" if detail else ""))
        failures.append(label)

for name, text, expected_fmt in [
    ("Android English", ANDROID_EN, "android"),
    ("iOS English",     IOS_EN,     "ios"),
    ("Android Arabic",  ANDROID_AR, "android"),
    ("Arabic-Indic",    ARABIC_INDIC, "android"),
]:
    r = parse(text)
    check(f"{name} — messages parsed", len(r.messages) > 0, f"got {len(r.messages)}")
    check(f"{name} — no parse errors", r.parse_errors == 0, f"errors={r.parse_errors}")
    check(f"{name} — format detected", r.format_detected == expected_fmt,
          f"expected {expected_fmt!r}, got {r.format_detected!r}")

# Burst grouping: Ahmed sends two messages back-to-back within 2 min
r = parse(ANDROID_EN)
m0, m1 = r.messages[0], r.messages[1]
check("Burst grouping (same sender, <2 min)", m0.burst_id == m1.burst_id,
      f"burst_ids: {m0.burst_id}, {m1.burst_id}")

# Media type detection
voice = next((m for m in r.messages if m.message_type == "voice"), None)
check("Voice note detected", voice is not None, "no voice message found")
if voice:
    check("Voice filename", voice.media_filename == "PTT-20231225-WA0001.opus")

image = next((m for m in r.messages if m.message_type == "image"), None)
check("Image detected", image is not None)
if image:
    check("Image filename", image.media_filename == "IMG-20231225-WA0001.jpg")

system = next((m for m in r.messages if m.message_type == "system"), None)
check("System message detected", system is not None)

multiline = next((m for m in r.messages if "\n" in m.body), None)
check("Multi-line body preserved", multiline is not None)
if multiline:
    check("Multi-line content", "second line" in multiline.body)

print()
if failures:
    print(f"FAILED: {len(failures)} check(s): {failures}")
    sys.exit(1)
else:
    print("All checks passed.")
