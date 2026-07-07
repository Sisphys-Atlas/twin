import sys
sys.path.insert(0, ".")
from app.parsing.whatsapp_parser import parse

text = open("../sample_chat.txt", encoding="utf-8").read()
r = parse(text)

real = [m for m in r.messages if m.sender]
sys_msgs = [m for m in r.messages if not m.sender]

print(f"Format      : {r.format_detected}")
print(f"Messages    : {len(r.messages)} ({len(real)} real, {len(sys_msgs)} system)")
print(f"Parse errors: {r.parse_errors}")
print(f"Participants: {r.participants}")
print(f"Date range  : {r.date_from.date()} -> {r.date_to.date()}")
print(f"Voice notes : {sum(1 for m in r.messages if m.message_type == 'voice')}")
print(f"Images      : {sum(1 for m in r.messages if m.message_type == 'image')}")
print(f"PDFs        : {sum(1 for m in r.messages if m.message_type == 'pdf')}")
bursts = len(set(m.burst_id for m in r.messages if m.burst_id is not None))
print(f"Bursts      : {bursts}")
