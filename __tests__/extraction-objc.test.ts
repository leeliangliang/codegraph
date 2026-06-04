/**
 * Objective-C Extraction Tests
 *
 * Covers the per-language extractor at src/extraction/languages/objc.ts plus
 * the detectLanguage / .h ObjC-vs-C heuristic in src/extraction/grammars.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, initGrammars, loadAllGrammars, isLanguageSupported } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('ObjC language detection', () => {
  it('routes .m files to objc', () => {
    expect(detectLanguage('MyVC.m')).toBe('objc');
  });

  it('routes .mm files to objc', () => {
    expect(detectLanguage('MyVC.mm')).toBe('objc');
  });

  it('routes .h with @interface to objc', () => {
    const src = `
#import <Foundation/Foundation.h>

@interface MyClass : NSObject
- (void)foo;
@end
`;
    expect(detectLanguage('MyClass.h', src)).toBe('objc');
  });

  it('routes .h with @protocol to objc', () => {
    const src = `
@protocol MyDelegate <NSObject>
- (void)didFinish;
@end
`;
    expect(detectLanguage('MyDelegate.h', src)).toBe('objc');
  });

  it('leaves plain C .h files as c', () => {
    const src = `
#ifndef STDLIB_H
#define STDLIB_H
int add(int a, int b);
#endif
`;
    expect(detectLanguage('stdlib.h', src)).toBe('c');
  });

  it('still routes C++ .h files to cpp when no ObjC tokens are present', () => {
    const src = `
namespace foo {
  class Bar {
    public:
      void baz();
  };
}
`;
    expect(detectLanguage('Bar.h', src)).toBe('cpp');
  });

  it('reports objc in the supported languages set', () => {
    expect(isLanguageSupported('objc')).toBe(true);
  });
});

describe('ObjC Extraction', () => {
  it('extracts @interface declarations as class nodes', () => {
    const code = `
@interface MyVC : UIViewController
- (void)viewDidLoad;
@end
`;
    const result = extractFromSource('MyVC.h', code);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'MyVC');
    expect(classNode).toBeDefined();
  });

  it('extracts @implementation declarations as class nodes', () => {
    const code = `
@implementation MyVC
- (void)viewDidLoad {
}
@end
`;
    const result = extractFromSource('MyVC.m', code);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'MyVC');
    expect(classNode).toBeDefined();
  });

  it('extracts @protocol declarations as protocol nodes', () => {
    const code = `
@protocol MyDelegate <NSObject>
- (void)didFinish:(id)result;
@optional
- (void)willStart;
@end
`;
    const result = extractFromSource('MyDelegate.h', code);
    const protocolNode = result.nodes.find((n) => n.kind === 'protocol' && n.name === 'MyDelegate');
    expect(protocolNode).toBeDefined();
  });

  it('extracts @property declarations as property nodes', () => {
    const code = `
@interface MyVC : UIViewController
@property (nonatomic, strong) NSString *title;
@property (nonatomic, assign) NSInteger count;
@end
`;
    const result = extractFromSource('MyVC.h', code);
    const props = result.nodes.filter((n) => n.kind === 'property');
    const names = props.map((n) => n.name).sort();
    expect(names).toContain('title');
    expect(names).toContain('count');
  });

  it('extracts method declarations and definitions with single-part selectors', () => {
    const code = `
@implementation Foo
- (void)viewDidLoad {
}
+ (instancetype)sharedInstance {
    return nil;
}
@end
`;
    const result = extractFromSource('Foo.m', code);
    const methods = result.nodes.filter((n) => n.kind === 'method');
    const names = methods.map((n) => n.name);
    expect(names).toContain('viewDidLoad');
    expect(names).toContain('sharedInstance');
  });

  it('joins multi-part selectors into the canonical selector name', () => {
    const code = `
@interface Dict : NSObject
- (void)setObject:(id)obj forKey:(NSString *)key;
@end
@implementation Dict
- (void)setObject:(id)obj forKey:(NSString *)key {
}
@end
`;
    const result = extractFromSource('Dict.m', code);
    const methods = result.nodes.filter((n) => n.kind === 'method' && n.name === 'setObject:forKey:');
    // Both the declaration in @interface and definition in @implementation produce a method node.
    expect(methods.length).toBeGreaterThanOrEqual(1);
  });

  it('encodes categories as qualified class names so siblings do not collide', () => {
    const code = `
@interface NSString (Reversing)
- (NSString *)reverse;
@end
@implementation NSString (Reversing)
- (NSString *)reverse {
    return self;
}
@end

@interface NSString (Trimming)
- (NSString *)trim;
@end
`;
    const result = extractFromSource('NSString+Categories.m', code);
    const reverseCat = result.nodes.find((n) => n.kind === 'class' && n.name === 'NSString(Reversing)');
    const trimCat = result.nodes.find((n) => n.kind === 'class' && n.name === 'NSString(Trimming)');
    expect(reverseCat).toBeDefined();
    expect(trimCat).toBeDefined();
    // No bare "NSString" class node — that would mean the category collapsed onto the base name.
    const bareNSString = result.nodes.find((n) => n.kind === 'class' && n.name === 'NSString');
    expect(bareNSString).toBeUndefined();
  });

  it('extracts message_expression calls as calls references', () => {
    const code = `
@implementation Foo
- (void)run {
    [self viewDidLoad];
    [obj setObject:nil forKey:@"k"];
    [[Foo alloc] init];
}
@end
`;
    const result = extractFromSource('Foo.m', code);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const calleeNames = new Set(calls.map((r) => r.referenceName));

    // Self-receiver: skip prefix → bare selector
    expect(calleeNames.has('viewDidLoad')).toBe(true);
    // Multi-part selector with non-skip receiver → "obj.setObject:forKey:"
    expect(calleeNames.has('obj.setObject:forKey:')).toBe(true);
    // Nested message: [Foo alloc] and [...alloc] init both recorded
    expect(calleeNames.has('Foo.alloc')).toBe(true);
    expect(calleeNames.has('init')).toBe(true);
  });

  it('extracts framework and quoted #import as import references', () => {
    const code = `
#import <UIKit/UIKit.h>
#import <Foundation/Foundation.h>
#import "MyHeader.h"
@import CoreData;

@interface Foo : NSObject
@end
`;
    const result = extractFromSource('Foo.m', code);
    const imports = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    const moduleNames = new Set(imports.map((r) => r.referenceName));
    expect(moduleNames.has('UIKit/UIKit.h')).toBe(true);
    expect(moduleNames.has('Foundation/Foundation.h')).toBe(true);
    expect(moduleNames.has('MyHeader.h')).toBe(true);
    expect(moduleNames.has('CoreData')).toBe(true);
  });

  it('parses .mm ObjC++ files without crashing (C++ symbols may be missed)', () => {
    const code = `
@interface MixedVC : UIViewController
@end
@implementation MixedVC
- (void)viewDidLoad {
    [super viewDidLoad];
}
@end
`;
    const result = extractFromSource('MixedVC.mm', code);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'MixedVC');
    expect(classNode).toBeDefined();
  });
});
