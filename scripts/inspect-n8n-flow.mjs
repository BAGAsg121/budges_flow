/**
 * Read an n8n workflow export structurally, for auditing a port against its original.
 *
 * Why this exists: an n8n export is a big nested JSON blob, and reading it by eye (or grepping it)
 * reliably hides the two things that matter when porting a flow —
 *   1. the CONNECTION graph, which is where branch order and chaining live (`Check Mobile` →
 *      false-branch → `Check PAN`, for instance), and
 *   2. the exact SQL / code-node text, which is the actual selection rule.
 * Both are easy to *assume* and hard to *see*, and a port that assumes them is wrong in a way no
 * test will catch, because the tests were written from the same assumption.
 *
 * Usage:
 *   node scripts/inspect-n8n-flow.mjs <export.json>              # every node, one block each
 *   node scripts/inspect-n8n-flow.mjs <export.json> --connections # the graph only
 *   node scripts/inspect-n8n-flow.mjs <export.json> --node "MySQL2"          # one node, verbatim
 *   node scripts/inspect-n8n-flow.mjs <export.json> --node "MySQL2" jsCode   # one parameter
 *   node scripts/inspect-n8n-flow.mjs <export.json> --grep "SELECT"          # search all node text
 *
 * Read-only: it never writes and never talks to a network.
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const file = argv[0]
if (!file) {
  console.error('usage: node scripts/inspect-n8n-flow.mjs <export.json> [--connections|--grep T|--node NAME [path]]')
  process.exit(2)
}

const doc = JSON.parse(readFileSync(file, 'utf8'))
const nodes = doc.nodes ?? []

/** n8n node type -> the short name a human would say. */
const shortType = (t) =>
  String(t ?? '').replace('n8n-nodes-base.', '').replace('@n8n/n8n-nodes-langchain.', '')

/** Flatten a parameter object into `path=value` lines, so the interesting text is greppable. */
function flatten(value, path = '', out = []) {
  if (value === null || value === undefined) return out
  if (typeof value !== 'object') {
    out.push([path, String(value)])
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out))
    return out
  }
  for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out)
  return out
}

/** One-line-per-field summary of a node, with long text truncated. */
function summarise(node) {
  console.log(`\n### ${node.name}  [${shortType(node.type)}]`)
  const scalars = flatten(node.parameters ?? {})
  for (const [path, value] of scalars) {
    const isLong = value.length > 90
    // Collapse whitespace so a multi-line SQL query stays on one line and stays readable.
    console.log(`    ${path} = ${isLong ? `${value.replace(/\s+/g, ' ').slice(0, 600)}…` : value}`)
  }
}

function connections() {
  for (const [from, outs] of Object.entries(doc.connections ?? {})) {
    for (const [kind, branches] of Object.entries(outs)) {
      branches.forEach((branch, i) => {
        for (const c of branch ?? []) {
          // The branch index only matters when a node has more than one output (an If node):
          // 0 is the true/first branch, 1 the false/second.
          const label = branches.length > 1 ? `${kind}:${i}` : kind
          console.log(`${from}  --[${label}]-->  ${c.node}`)
        }
      })
    }
  }
}

const mode = argv.find((a) => a.startsWith('--'))

if (mode === '--connections') {
  connections()
} else if (mode === '--node') {
  const name = argv[argv.indexOf('--node') + 1]
  const path = argv.slice(argv.indexOf('--node') + 2).filter((a) => !a.startsWith('--'))
  const node = nodes.find((n) => n.name === name)
  if (!node) {
    console.error(`no node named "${name}". Nodes: ${nodes.map((n) => n.name).join(', ')}`)
    process.exit(1)
  }
  let value = node.parameters
  // Supports `conditions.conditions[0].leftValue` as well as plain dotted keys: array indices are
  // written in brackets, which is where the interesting If-node condition text lives.
  for (const rawPart of path) {
    for (const part of rawPart.split(/\.(?![^\[]*\])/)) {
      if (value === undefined || value === null) break
      const m = part.match(/^([^[]*)((?:\[\d+\])*)$/)
      if (!m) continue
      if (m[1]) value = value[m[1]]
      for (const idx of m[2].match(/\d+/g) ?? []) value = value?.[Number(idx)]
    }
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
} else if (mode === '--grep') {
  const needle = argv[argv.indexOf('--grep') + 1] ?? ''
  const re = new RegExp(needle, 'i')
  for (const node of nodes) {
    for (const [path, value] of flatten(node.parameters ?? {})) {
      const pathHit = re.test(path)
      const valueHit = re.test(value)
      if (!pathHit && !valueHit) continue
      console.log(`\n### ${node.name}  [${shortType(node.type)}]  ${path}`)
      if (pathHit) {
        // The field NAME matched, so the whole value is the answer (a numbers-only rule, say).
        console.log(`    ${value}`)
        continue
      }
      // Otherwise only show the lines that actually matched, so a 200-line code node stays readable.
      for (const line of value.split('\n')) {
        if (re.test(line)) console.log(`    ${line.trim()}`)
      }
    }
  }
} else {
  for (const node of nodes) summarise(node)
  console.log('\n--- connections ---')
  connections()
}
