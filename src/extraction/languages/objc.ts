import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Objective-C extractor.
 *
 * Uses tree-sitter-objc — shipped as `tree-sitter-objc.wasm` by the
 * `tree-sitter-wasms` npm package.
 *
 * Known limits (deliberate scope for the initial pass):
 *   - `.mm` ObjC++ files parse via the same grammar, which has no C++ rules.
 *     C++ symbols inside `.mm` files are silently dropped; ObjC structure is
 *     extracted normally.
 *   - Message-send call resolution is syntactic — we record the selector and
 *     (when non-skip-ish) the receiver text, but don't resolve dynamic dispatch
 *     to a concrete target. That's a fundamental tree-sitter limit; the
 *     semantic story belongs to IndexStoreDB on macOS.
 *   - Class → protocol conformance edges (the `<Foo, Bar>` list after a
 *     superclass) are deferred; the grammar parses them as
 *     `parameterized_arguments`, which collides with generic syntax.
 *
 * message_expression call extraction lives in the core `extractCall` dispatcher
 * (tree-sitter.ts) — same place as Java's method_invocation and Kotlin's
 * navigation_expression — so it works inside method bodies too.
 */

/** Read a method_declaration / method_definition's selector parts and join into the canonical
 *  ObjC selector identifier (`viewDidLoad`, `setObject:forKey:`, …). */
function readSelector(node: SyntaxNode, source: string): string | null {
  const parts: string[] = [];
  let sawParam = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      parts.push(getNodeText(child, source));
    } else if (child.type === 'method_parameter') {
      sawParam = true;
    }
  }
  if (parts.length === 0) return null;
  // Single-segment, no params: bare selector like `viewDidLoad`.
  // Multi-segment, or single-segment with a parameter: trailing `:` per ObjC convention.
  if (parts.length === 1 && !sawParam) return parts[0]!;
  return parts.join(':') + ':';
}

/** Extract the property identifier from a property_declaration. The grammar buries it inside
 *  struct_declaration > struct_declarator > pointer_declarator? > identifier. */
function readPropertyName(node: SyntaxNode, source: string): string | null {
  const structDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'struct_declaration');
  if (!structDecl) return null;
  const declarator = structDecl.namedChildren.find((c: SyntaxNode) => c.type === 'struct_declarator');
  if (!declarator) {
    const id = structDecl.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    return id ? getNodeText(id, source) : null;
  }
  let cur: SyntaxNode | null = declarator;
  while (cur && cur.type !== 'identifier') {
    const next: SyntaxNode | undefined = cur.namedChildren.find((c: SyntaxNode) =>
      c.type === 'pointer_declarator' || c.type === 'identifier'
    );
    if (!next || next === cur) break;
    cur = next;
  }
  return cur && cur.type === 'identifier' ? getNodeText(cur, source) : null;
}

export const objcExtractor: LanguageExtractor = {
  // class_interface and class_implementation are the two class containers.
  // implementation_definition is a thin wrapper inside class_implementation that
  // wraps each method_definition; the default visitor recurses through it.
  classTypes: ['class_interface', 'class_implementation'],
  // method_declaration is in @interface bodies; method_definition is in @implementation bodies.
  methodTypes: ['method_declaration', 'method_definition'],
  // ObjC protocols map to the existing 'protocol' NodeKind via interfaceKind override.
  interfaceTypes: ['protocol_declaration'],
  interfaceKind: 'protocol',
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'],
  importTypes: ['preproc_include', 'module_import'],
  callTypes: ['call_expression', 'message_expression'],
  variableTypes: ['declaration'],
  propertyTypes: ['property_declaration'],
  functionTypes: ['function_definition'], // top-level C-style functions occasionally appear in OC sources

  // The grammar has no `name` field on the top-level OC declarations — the
  // class/protocol/method name is the first identifier child. The core
  // extractName() function already has a "first identifier" fallback, so we
  // leave nameField pointing at an unused field name and let the fallback kick in.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node, source) => {
    // For methods, the full header (return type + selector + parameter types) is the most
    // useful signature. Slice everything up to the body if there is one, else use the whole node.
    if (node.type === 'method_declaration' || node.type === 'method_definition') {
      const body = node.namedChildren.find((c: SyntaxNode) => c.type === 'compound_statement');
      const end = body ? body.startIndex : node.endIndex;
      return source.substring(node.startIndex, end).trim().replace(/;$/, '').trim() || undefined;
    }
    return undefined;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // @import CoreData;
    if (node.type === 'module_import') {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (!id) return null;
      return { moduleName: getNodeText(id, source), signature: importText };
    }

    // #import <Framework/Header.h> or #include <stdio.h>
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return {
        moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''),
        signature: importText,
      };
    }

    // #import "MyHeader.h"
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },

  visitNode: (node, ctx: ExtractorContext) => {
    // ----- Categories (@interface Foo (Bar) / @implementation Foo (Bar)) -----
    // The grammar parses both `class_interface` and `class_implementation`
    // with a `category` field when the source declares a category. We synthesize
    // a qualified name `Foo(Bar)` so multiple categories on the same base class
    // don't collide as a single "Foo" node.
    if (node.type === 'class_interface' || node.type === 'class_implementation') {
      const category = getChildByField(node, 'category');
      if (!category) return false; // not a category — let default extractClass run

      const baseId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (!baseId) return true; // malformed, swallow
      const baseName = getNodeText(baseId, ctx.source);
      const categoryName = getNodeText(category, ctx.source);
      const qualifiedName = `${baseName}(${categoryName})`;

      const classNode = ctx.createNode('class', qualifiedName, node);
      if (classNode) {
        ctx.pushScope(classNode.id);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) ctx.visitNode(child);
        }
        ctx.popScope();
      }
      return true;
    }

    // ----- Properties (@property (nonatomic, strong) NSString *title;) -----
    // The property name is buried inside struct_declaration > struct_declarator >
    // pointer_declarator > identifier. The core extractProperty looks for a `name`
    // field or first identifier child — but the first identifier under property_declaration
    // is "nonatomic" (or another attribute), which is wrong. Handle manually.
    if (node.type === 'property_declaration') {
      const name = readPropertyName(node, ctx.source);
      if (!name) return true; // unknown shape — swallow rather than mislabel
      const signature = source(node, ctx.source);
      ctx.createNode('property', name, node, { signature });
      return true;
    }

    // ----- Method declarations and definitions -----
    // The grammar exposes selector parts as identifier children with method_parameter
    // children interleaved. The core extractName fallback returns just the FIRST identifier
    // (e.g., "setObject" for `setObject:forKey:`), losing the multi-arg selector identity.
    // We compute the canonical selector and create the method node ourselves.
    if (node.type === 'method_declaration' || node.type === 'method_definition') {
      const selector = readSelector(node, ctx.source);
      if (!selector) return false;
      const signature = source(node, ctx.source).replace(/;$/, '').trim();
      const methodNode = ctx.createNode('method', selector, node, { signature });
      if (methodNode && node.type === 'method_definition') {
        const body = node.namedChildren.find((c: SyntaxNode) => c.type === 'compound_statement');
        if (body) ctx.visitFunctionBody(body, methodNode.id);
      }
      return true;
    }

    // Note: message_expression call extraction lives in the core extractCall()
    // dispatcher (tree-sitter.ts) — same place as Java's method_invocation and
    // Kotlin's navigation_expression. Keeping it there ensures both the top-level
    // walker and visitFunctionBody pick up message sends inside method bodies.

    return false;
  },
};

/** Inline source-slicer to avoid threading `source` through every helper. */
function source(node: SyntaxNode, src: string): string {
  return src.substring(node.startIndex, node.endIndex);
}
