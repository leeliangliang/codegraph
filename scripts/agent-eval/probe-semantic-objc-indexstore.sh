#!/usr/bin/env bash
# Build tiny ObjC/C/C++/Swift projects with REAL clang/swift IndexStore output,
# enrich them with codegraph-xchelper, and verify the semantic-objc overlay that
# agents depend on for flow questions.
#
# Usage:
#   scripts/agent-eval/probe-semantic-objc-indexstore.sh
#
# Requirements:
#   - macOS + Xcode toolchain (clang, swiftc, libIndexStore)
#   - npm run build
#   - npm run build:mac-objc-helper, or HELPER=/path/to/codegraph-xchelper
#   - sqlite3 CLI for direct DB inspection

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "semantic-objc IndexStore probe requires macOS" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
CLI=${CLI:-"$REPO_ROOT/dist/bin/codegraph.js"}
HELPER=${HELPER:-"$REPO_ROOT/packages/mac-objc-enricher/bin/codegraph-xchelper"}
KEEP=${KEEP:-0}

if [[ ! -f "$CLI" ]]; then
  echo "missing built CLI: $CLI (run: npm run build)" >&2
  exit 1
fi
if [[ ! -x "$HELPER" ]]; then
  echo "missing helper: $HELPER (run: npm run build:mac-objc-helper, or set HELPER=...)" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 CLI is required for DB assertions" >&2
  exit 1
fi

ROOT=${ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/codegraph-semobjc-indexstore.XXXXXX")}
if [[ "$KEEP" != "1" ]]; then
  trap 'rm -rf "$ROOT"' EXIT
fi

mkdir -p "$ROOT"
echo "workspace: $ROOT"

write_fixtures() {
  # Objective-C: dynamic dispatch + data-flow + decl->def + include graph.
  mkdir -p "$ROOT/objc/Sources" "$ROOT/objc/.indexstore"
  cat > "$ROOT/objc/Sources/Counter.h" <<'EOF'
#import <Foundation/Foundation.h>

@interface Counter : NSObject
@property(nonatomic) int value;
- (void)increment;
- (int)readValue;
@end
EOF
  cat > "$ROOT/objc/Sources/SpecialCounter.h" <<'EOF'
#import "Counter.h"

@interface SpecialCounter : Counter
- (void)increment;
@end
EOF
  cat > "$ROOT/objc/Sources/Counter.m" <<'EOF'
#import "Counter.h"

@implementation Counter
- (void)increment {
    self.value = self.value + 1;
}
- (int)readValue {
    return self.value;
}
@end
EOF
  cat > "$ROOT/objc/Sources/SpecialCounter.m" <<'EOF'
#import "SpecialCounter.h"

@implementation SpecialCounter
- (void)increment {
    self.value = self.value + 10;
}
@end
EOF
  cat > "$ROOT/objc/Sources/main.m" <<'EOF'
#import "SpecialCounter.h"

void runCounter(Counter *counter) {
    [counter increment];
    (void)[counter readValue];
}
EOF

  # C: address-of / function pointer.
  mkdir -p "$ROOT/c/Sources" "$ROOT/c/.indexstore"
  cat > "$ROOT/c/Sources/callbacks.h" <<'EOF'
void handler(void);
void register_handler(void (*cb)(void));
EOF
  cat > "$ROOT/c/Sources/callbacks.c" <<'EOF'
#include "callbacks.h"
void handler(void) {}
void register_handler(void (*cb)(void)) { cb(); }
void setup(void) { register_handler(&handler); }
EOF

  # C++: virtual override + dynamic call + template-specialization metadata.
  mkdir -p "$ROOT/cpp/Sources" "$ROOT/cpp/.indexstore"
  cat > "$ROOT/cpp/Sources/virtuals.cpp" <<'EOF'
struct Base {
  virtual void tick();
};
struct Derived : Base {
  void tick() override;
};
void Base::tick() {}
void Derived::tick() {}
void drive(Base *b) { b->tick(); }

template <typename T>
T id(T value) { return value; }
int useTemplate() { return id<int>(42); }
EOF

  # Swift: async + generic metadata + direct semantic call.
  mkdir -p "$ROOT/swift/Sources" "$ROOT/swift/.indexstore"
  cat > "$ROOT/swift/Sources/AsyncBox.swift" <<'EOF'
public struct Box<T> {
    public let value: T
    public init(_ value: T) { self.value = value }
}

public func makeBox() -> Box<Int> {
    Box(1)
}

public func fetchValue() async -> Int {
    return makeBox().value
}
EOF
}

build_indexstores() {
  local sdk
  sdk=$(xcrun --sdk macosx --show-sdk-path)

  clang -fsyntax-only -fmodules -fobjc-arc -isysroot "$sdk" \
    -index-store-path "$ROOT/objc/.indexstore" \
    "$ROOT/objc/Sources/Counter.m" \
    "$ROOT/objc/Sources/SpecialCounter.m" \
    "$ROOT/objc/Sources/main.m"

  clang -fsyntax-only \
    -index-store-path "$ROOT/c/.indexstore" \
    "$ROOT/c/Sources/callbacks.c"

  clang++ -std=c++20 -fsyntax-only \
    -index-store-path "$ROOT/cpp/.indexstore" \
    "$ROOT/cpp/Sources/virtuals.cpp"

  swiftc -typecheck \
    -index-store-path "$ROOT/swift/.indexstore" \
    "$ROOT/swift/Sources/AsyncBox.swift"
}

summary_json_field() {
  local file=$1 field=$2
  node -e "const s=require(process.argv[1]); console.log(s[process.argv[2]] ?? 0)" "$file" "$field"
}

assert_summary_ge() {
  local fixture=$1 field=$2 min=$3
  local value
  value=$(summary_json_field "$ROOT/$fixture/summary.json" "$field")
  if (( value < min )); then
    echo "ASSERT FAIL: $fixture summary.$field = $value, expected >= $min" >&2
    exit 1
  fi
  echo "ok: $fixture summary.$field = $value >= $min"
}

assert_sql_count_ge() {
  local fixture=$1 sql=$2 min=$3 label=$4
  local db="$ROOT/$fixture/.codegraph/codegraph.db"
  local value
  value=$(sqlite3 "$db" "$sql")
  if (( value < min )); then
    echo "ASSERT FAIL: $fixture $label = $value, expected >= $min" >&2
    exit 1
  fi
  echo "ok: $fixture $label = $value >= $min"
}

index_and_enrich() {
  local fixture=$1 lang=$2
  node "$CLI" init "$ROOT/$fixture" >/dev/null
  node "$CLI" index "$ROOT/$fixture" >/dev/null
  node "$CLI" enrich-objc "$ROOT/$fixture" \
    --helper "$HELPER" \
    --store-path "$ROOT/$fixture/.indexstore" \
    --source-root "$ROOT/$fixture" \
    --language "$lang" \
    --json > "$ROOT/$fixture/summary.json"
}

run_explore_probe() {
  local fixture=$1 query=$2 expectedLine=$3
  node "$REPO_ROOT/scripts/agent-eval/probe-explore.mjs" "$ROOT/$fixture" "$query" \
    > "$ROOT/$fixture/explore.txt" \
    2> "$ROOT/$fixture/explore.stats"
  if ! grep -Fxq -- "$expectedLine" "$ROOT/$fixture/explore.txt"; then
    echo "ASSERT FAIL: $fixture explore output missing exact line: $expectedLine" >&2
    echo "--- explore output ---" >&2
    sed -n '1,120p' "$ROOT/$fixture/explore.txt" >&2
    exit 1
  fi
  echo "ok: $fixture explore contains exact line '$expectedLine'"
}

write_fixtures
build_indexstores

index_and_enrich objc objc
index_and_enrich c c
index_and_enrich cpp cpp
index_and_enrich swift swift

# Summary-level checks: these prove the real helper/indexstore path exercised the
# added merger phases, not only synthetic NDJSON unit tests.
assert_summary_ge objc dynamicDispatchSynthesized 1
assert_summary_ge objc refsDataflowMerged 1
assert_summary_ge objc includeEdgesMerged 1
assert_summary_ge objc declEdgesMerged 1
assert_summary_ge c selectorEdgesSynthesized 1
assert_summary_ge c includeEdgesMerged 1
assert_summary_ge c declEdgesMerged 1
assert_summary_ge cpp dynamicDispatchSynthesized 1
assert_summary_ge cpp relsMerged 1
assert_summary_ge swift asyncSymbolsMarked 1
assert_summary_ge swift refsMerged 1

# DB endpoint checks: summary counts are insufficient, because bad matching could
# put an edge on a file/class node. These assert the agent-visible relationships.
assert_sql_count_ge objc "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic' and json_extract(e.metadata,'$.synthesizedBy')='indexstore-dynamic-dispatch' and s.name='runCounter' and t.name='increment';" 1 "runCounter→increment dynamic-dispatch edge"
assert_sql_count_ge objc "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='semantic-objc' and e.kind='references' and s.name='increment' and t.name='value';" 1 "increment→value data-flow edge"
assert_sql_count_ge c "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic' and json_extract(e.metadata,'$.synthesizedBy')='indexstore-indirect-ref' and s.name='setup' and t.name='handler';" 1 "setup→handler indirect-ref edge"
assert_sql_count_ge cpp "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic' and json_extract(e.metadata,'$.synthesizedBy')='indexstore-dynamic-dispatch' and s.name='drive' and t.name='tick';" 1 "drive→tick dynamic-dispatch edge"
assert_sql_count_ge swift "select count(*) from nodes where name='fetchValue' and is_async=1;" 1 "fetchValue async marker"
assert_sql_count_ge swift "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='semantic-objc' and e.kind='calls' and s.name='fetchValue' and t.name='makeBox';" 1 "fetchValue→makeBox semantic call edge"

# Surface checks: the relationships must appear in codegraph_explore, because
# that is the tool agents reliably call for flow questions.
run_explore_probe objc "runCounter increment readValue value" '- runCounter → increment   [dynamic: `increment` → impl @Sources/main.m:4]'
run_explore_probe c "setup handler register_handler" '- setup → handler   [dynamic: `handler` via selector/fn-ref @Sources/callbacks.c:4]'
run_explore_probe cpp "drive tick Derived Base" '- drive → tick   [dynamic: `tick` → impl @Sources/virtuals.cpp:9]'
run_explore_probe swift "fetchValue makeBox Box" $'11\t    return makeBox().value'

cat <<EOF

semantic-objc IndexStore probe passed.
workspace: $ROOT
summaries:
  objc:  $ROOT/objc/summary.json
  c:     $ROOT/c/summary.json
  cpp:   $ROOT/cpp/summary.json
  swift: $ROOT/swift/summary.json
EOF

if [[ "$KEEP" == "1" ]]; then
  echo "KEEP=1 set; workspace preserved."
fi
