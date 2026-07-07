import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")
from app.parsing.whatsapp_parser import parse

# Arabic body text — م and ص must NOT be replaced
ar_body = """\
25/12/2023, 15:45 - Sara: الموردين رفعوا أسعارهم في أكتوبر وما قدرنا نعدل بسرعة كافية
25/12/2023, 15:46 - Ahmed: صح كلامك يا سارة
25/12/2023, 15:47 - Sara: مرحبا بالجميع
"""

r = parse(ar_body)
for m in r.messages:
    bad = "PM" in (m.body or "") or "AM" in (m.body or "")
    status = "FAIL - mangled" if bad else "OK"
    print(f"[{status}] {m.sender}: {m.body}")

print()

# 12h with Arabic AM/PM marker — must parse the time correctly
ar_ampm = """\
25/12/2023، 3:45 م - Ahmed: مرحبا
25/12/2023، 9:00 ص - Sara: صباح الخير
"""

r2 = parse(ar_ampm)
for m in r2.messages:
    bad = "PM" in (m.body or "") or "AM" in (m.body or "")
    print(f"[{'FAIL' if bad else 'OK'}] time={m.timestamp.strftime('%H:%M')} body={m.body}")

print()

# Sample file
text = open("../sample_chat.txt", encoding="utf-8").read()
r3 = parse(text)
print(f"Sample file: {len(r3.messages)} messages, {r3.parse_errors} errors")
sara = next((m for m in r3.messages if m.sender == "Sara" and "الموردين" in (m.body or "")), None)
if sara:
    bad = "PM" in sara.body or "AM" in sara.body
    print(f"[{'FAIL' if bad else 'OK'}] Sara's Arabic message: {sara.body}")
else:
    print("Sara's Arabic message not found")
