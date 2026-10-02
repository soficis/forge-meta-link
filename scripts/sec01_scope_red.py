import json, sys, pathlib
p = pathlib.Path("src-tauri/tauri.conf.json")
data = json.loads(p.read_text(encoding="utf-8"))
scope = data.get("app",{}).get("security",{}).get("assetProtocol",{}).get("scope")
expected = ["$APPDATA/**"]
print(f"Current scope: {scope}")
print(f"Expected: {expected}")
# baseline check: wildcards present?
wildcards = ["**/*", "?:/**", "?:\\**", "[A-Za-z]:/**", "[A-Za-z]:\\**", "$HOME/**", "$RESOURCE/**"]
found_wildcards = [w for w in wildcards if w in (scope or [])]
print(f"Found overly-broad entries: {found_wildcards}")
if scope == expected:
    print("PASS: static scope is restricted to $APPDATA/** (dynamic scopes granted at runtime)")
    sys.exit(0)
else:
    print("FAIL: scope != expected — RED confirmed")
    sys.exit(1)
