/**
 * Extraction Tests
 *
 * Tests for the tree-sitter extraction system.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, isLanguageSupported, getSupportedLanguages, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages([
    'pascal',
    'scala',
    'typescript',
    'javascript',
    'lua',
    'luau',
  ]);
});

describe('Pascal / Delphi Extraction', () => {
  describe('Language detection', () => {
    it('should detect Pascal files', () => {
      expect(detectLanguage('UAuth.pas')).toBe('pascal');
      expect(detectLanguage('App.dpr')).toBe('pascal');
      expect(detectLanguage('Package.dpk')).toBe('pascal');
      expect(detectLanguage('App.lpr')).toBe('pascal');
      expect(detectLanguage('MainForm.dfm')).toBe('pascal');
      expect(detectLanguage('MainForm.fmx')).toBe('pascal');
    });

    it('should report Pascal as supported', () => {
      expect(isLanguageSupported('pascal')).toBe(true);
      expect(getSupportedLanguages()).toContain('pascal');
    });
  });

  describe('Unit extraction', () => {
    it('should extract unit as module', () => {
      const code = `unit MyUnit;\ninterface\nimplementation\nend.`;
      const result = extractFromSource('MyUnit.pas', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyUnit');
      expect(moduleNode?.language).toBe('pascal');
    });

    it('should extract program as module', () => {
      const code = `program MyApp;\nbegin\nend.`;
      const result = extractFromSource('MyApp.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyApp');
    });

    it('should fallback to filename when module name is empty', () => {
      // Some .dpr templates use "program;" without a name
      const code = `program;\nuses SysUtils;\nbegin\nend.`;
      const result = extractFromSource('Console.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('Console');
    });
  });

  describe('Uses clause (imports)', () => {
    it('should extract uses as individual imports', () => {
      const code = `unit Test;\ninterface\nuses\n  System.SysUtils,\n  System.Classes;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);
      expect(imports.map((n) => n.name)).toContain('System.SysUtils');
      expect(imports.map((n) => n.name)).toContain('System.Classes');
    });

    it('should create unresolved references for imports', () => {
      const code = `unit Test;\ninterface\nuses\n  UAuth;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports'
      );
      expect(importRef).toBeDefined();
      expect(importRef?.referenceName).toBe('UAuth');
    });
  });

  describe('Class extraction', () => {
    it('should extract class declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  public\n    procedure DoSomething;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TMyClass');
    });

    it('should extract class with inheritance', () => {
      const code = `unit Test;\ninterface\ntype\n  TChild = class(TParent)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef).toBeDefined();
      expect(extendsRef?.referenceName).toBe('TParent');
    });

    it('should extract class with interface implementation', () => {
      const code = `unit Test;\ninterface\ntype\n  TService = class(TInterfacedObject, ILogger)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');
      expect(implementsRef?.referenceName).toBe('ILogger');
    });
  });

  describe('Record extraction', () => {
    it('should extract records as class nodes', () => {
      const code = `unit Test;\ninterface\ntype\n  TPoint = record\n    X: Double;\n    Y: Double;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TPoint');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });
  });

  describe('Interface extraction', () => {
    it('should extract interface declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  ILogger = interface\n    procedure Log(const AMsg: string);\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('ILogger');
    });
  });

  describe('Method extraction', () => {
    it('should extract methods with visibility', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  private\n    FValue: Integer;\n  public\n    constructor Create;\n    function GetValue: Integer;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBe(2);

      const createMethod = methods.find((m) => m.name === 'Create');
      expect(createMethod?.visibility).toBe('public');

      const getValue = methods.find((m) => m.name === 'GetValue');
      expect(getValue?.visibility).toBe('public');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      const fValue = fields.find((f) => f.name === 'FValue');
      expect(fValue?.visibility).toBe('private');
    });

    it('should detect static methods (class methods)', () => {
      const code = `unit Test;\ninterface\ntype\n  THelper = class\n  public\n    class function Create: THelper; static;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'Create');
      expect(staticMethod?.isStatic).toBe(true);
    });
  });

  describe('Enum extraction', () => {
    it('should extract enums with members', () => {
      const code = `unit Test;\ninterface\ntype\n  TColor = (clRed, clGreen, clBlue);\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode).toBeDefined();
      expect(enumNode?.name).toBe('TColor');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['clRed', 'clGreen', 'clBlue']);
    });
  });

  describe('Property extraction', () => {
    it('should extract properties', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    property Name: string read FName write FName;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const propNode = result.nodes.find((n) => n.kind === 'property');
      expect(propNode).toBeDefined();
      expect(propNode?.name).toBe('Name');
      expect(propNode?.visibility).toBe('public');
    });
  });

  describe('Constant extraction', () => {
    it('should extract constants', () => {
      const code = `unit Test;\ninterface\nconst\n  MAX_RETRIES = 3;\n  APP_NAME = 'MyApp';\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('APP_NAME');
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `unit Test;\ninterface\ntype\n  TUserName = string;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const aliasNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(aliasNode).toBeDefined();
      expect(aliasNode?.name).toBe('TUserName');
    });
  });

  describe('Call extraction', () => {
    it('should extract calls from implementation bodies', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure DoWork;\n  end;\nimplementation\nprocedure TObj.DoWork;\nbegin\n  WriteLn('hello');\nend;\nend.`;
      const result = extractFromSource('Test.pas', code);

      const callRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRef).toBeDefined();
      expect(callRef?.referenceName).toBe('WriteLn');
    });
  });

  describe('Containment edges', () => {
    it('should create contains edges for class members', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure Foo;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(classNode).toBeDefined();
      expect(methodNode).toBeDefined();

      const containsEdge = result.edges.find(
        (e) => e.source === classNode?.id && e.target === methodNode?.id && e.kind === 'contains'
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('Full fixture: UAuth.pas', () => {
    const code = `unit UAuth;

interface

uses
  System.SysUtils,
  System.Classes;

type
  ITokenValidator = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Validate(const AToken: string): Boolean;
  end;

  TAuthService = class(TInterfacedObject, ITokenValidator)
  private
    FToken: string;
    FLoginCount: Integer;
    procedure IncLoginCount;
  protected
    function GetToken: string;
  public
    constructor Create;
    destructor Destroy; override;
    function Validate(const AToken: string): Boolean;
    function Login(const AUser, APass: string): string;
    property Token: string read GetToken;
    property LoginCount: Integer read FLoginCount;
  end;

implementation

constructor TAuthService.Create;
begin
  inherited Create;
  FToken := '';
  FLoginCount := 0;
end;

destructor TAuthService.Destroy;
begin
  FToken := '';
  inherited Destroy;
end;

procedure TAuthService.IncLoginCount;
begin
  Inc(FLoginCount);
end;

function TAuthService.GetToken: string;
begin
  Result := FToken;
end;

function TAuthService.Validate(const AToken: string): Boolean;
begin
  Result := AToken <> '';
end;

function TAuthService.Login(const AUser, APass: string): string;
begin
  IncLoginCount;
  if Validate(AUser + ':' + APass) then
  begin
    FToken := AUser;
    Result := 'ok';
  end
  else
    Result := '';
end;

end.`;

    it('should extract all expected nodes', () => {
      const result = extractFromSource('UAuth.pas', code);

      expect(result.errors).toHaveLength(0);

      // Module
      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode?.name).toBe('UAuth');

      // Imports
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);

      // Interface
      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode?.name).toBe('ITokenValidator');

      // Class
      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode?.name).toBe('TAuthService');

      // Methods
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(6);
      expect(methods.map((m) => m.name)).toContain('Create');
      expect(methods.map((m) => m.name)).toContain('Destroy');
      expect(methods.map((m) => m.name)).toContain('Login');

      // Fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.every((f) => f.visibility === 'private')).toBe(true);

      // Properties
      const props = result.nodes.filter((n) => n.kind === 'property');
      expect(props.length).toBe(2);
      expect(props.map((p) => p.name)).toContain('Token');
      expect(props.map((p) => p.name)).toContain('LoginCount');
    });

    it('should extract inheritance and interface implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const extendsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'extends'
      );
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');

      const implementsRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'implements'
      );
      expect(implementsRef?.referenceName).toBe('ITokenValidator');
    });

    it('should extract calls from implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const callRefs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'calls'
      );
      expect(callRefs.map((r) => r.referenceName)).toContain('Inc');
      expect(callRefs.map((r) => r.referenceName)).toContain('Validate');
    });
  });

  describe('Full fixture: UTypes.pas', () => {
    const code = `unit UTypes;

interface

uses
  System.SysUtils;

const
  C_MAX_RETRIES = 3;
  C_DEFAULT_NAME = 'Guest';

type
  TUserRole = (urAdmin, urEditor, urViewer);

  TPoint2D = record
    X: Double;
    Y: Double;
  end;

  TUserName = string;

  TUserInfo = class
  public
    type
      TAddress = record
        Street: string;
        City: string;
        Zip: string;
      end;
  private
    FName: TUserName;
    FRole: TUserRole;
    FAddress: TAddress;
  public
    constructor Create(const AName: TUserName; ARole: TUserRole);
    function GetDisplayName: string;
    class function CreateAdmin(const AName: TUserName): TUserInfo; static;
    property Name: TUserName read FName write FName;
    property Role: TUserRole read FRole;
    property Address: TAddress read FAddress write FAddress;
  end;

implementation

constructor TUserInfo.Create(const AName: TUserName; ARole: TUserRole);
begin
  FName := AName;
  FRole := ARole;
end;

function TUserInfo.GetDisplayName: string;
begin
  if FRole = urAdmin then
    Result := '[Admin] ' + FName
  else
    Result := FName;
end;

class function TUserInfo.CreateAdmin(const AName: TUserName): TUserInfo;
begin
  Result := TUserInfo.Create(AName, urAdmin);
end;

end.`;

    it('should extract enums with members', () => {
      const result = extractFromSource('UTypes.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode?.name).toBe('TUserRole');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['urAdmin', 'urEditor', 'urViewer']);
    });

    it('should extract constants', () => {
      const result = extractFromSource('UTypes.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('C_MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('C_DEFAULT_NAME');
    });

    it('should extract type aliases', () => {
      const result = extractFromSource('UTypes.pas', code);

      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.map((a) => a.name)).toContain('TUserName');
    });

    it('should extract records as classes with fields', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TPoint2D');

      // TPoint2D fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });

    it('should extract static class methods', () => {
      const result = extractFromSource('UTypes.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'CreateAdmin');
      expect(staticMethod).toBeDefined();
      expect(staticMethod?.isStatic).toBe(true);
    });

    it('should extract nested types', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TAddress');
    });
  });
});

// =============================================================================
// DFM/FMX Extraction
// =============================================================================

describe('DFM/FMX Extraction', () => {
  it('should extract components from DFM', () => {
    const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
    expect(components.map((c) => c.name)).toContain('Button1');

    const button = components.find((c) => c.name === 'Button1');
    expect(button?.signature).toBe('TButton');
  });

  it('should extract nested component hierarchy', () => {
    const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(3);

    // Check nesting: Panel1 contains Label1
    const panel = components.find((c) => c.name === 'Panel1');
    const label = components.find((c) => c.name === 'Label1');
    const containsEdge = result.edges.find(
      (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains'
    );
    expect(containsEdge).toBeDefined();
  });

  it('should extract event handler references', () => {
    const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(3);
    expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
    expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
    expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
    expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('should handle multi-line properties', () => {
    const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.referenceName).toBe('Button1Click');
  });

  it('should handle inherited keyword', () => {
    const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
  });

  it('should handle item collection properties', () => {
    const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
  });

  describe('Full fixture: MainForm.dfm', () => {
    const code = `object frmMain: TfrmMain
  Left = 0
  Top = 0
  Caption = 'CodeGraph DFM Fixture'
  ClientHeight = 480
  ClientWidth = 640
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object pnlTop: TPanel
    Left = 0
    Top = 0
    Width = 640
    Height = 50
    object lblTitle: TLabel
      Left = 16
      Top = 16
      Caption = 'Authentication Service'
    end
    object btnLogin: TButton
      Left = 540
      Top = 12
      OnClick = btnLoginClick
    end
  end
  object pnlContent: TPanel
    Left = 0
    Top = 50
    object edtUsername: TEdit
      Left = 16
      Top = 16
      OnChange = edtUsernameChange
    end
    object edtPassword: TEdit
      Left = 16
      Top = 48
      OnKeyPress = edtPasswordKeyPress
    end
    object mmoLog: TMemo
      Left = 16
      Top = 88
    end
  end
  object pnlStatus: TStatusBar
    Left = 0
    Top = 440
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;

    it('should extract all components', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(9);
      expect(components.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'frmMain', 'pnlTop', 'lblTitle', 'btnLogin',
          'pnlContent', 'edtUsername', 'edtPassword', 'mmoLog', 'pnlStatus',
        ])
      );
    });

    it('should extract all event handlers', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(5);
      expect(refs.map((r) => r.referenceName)).toEqual(
        expect.arrayContaining([
          'FormCreate', 'FormDestroy', 'btnLoginClick',
          'edtUsernameChange', 'edtPasswordKeyPress',
        ])
      );
    });
  });
});

describe('Scala Extraction', () => {
  describe('Language detection', () => {
    it('should detect Scala files', () => {
      expect(detectLanguage('Main.scala')).toBe('scala');
      expect(detectLanguage('script.sc')).toBe('scala');
      expect(detectLanguage('src/UserService.scala')).toBe('scala');
    });

    it('should report Scala as supported', () => {
      expect(isLanguageSupported('scala')).toBe(true);
      expect(getSupportedLanguages()).toContain('scala');
    });
  });

  describe('Class extraction', () => {
    it('should extract class definitions', () => {
      const code = `
class UserService(private val repo: UserRepository) {
  def findUser(id: String): Option[String] = Some(id)
}
`;
      const result = extractFromSource('UserService.scala', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserService');
      expect(cls).toBeDefined();
      expect(cls?.language).toBe('scala');
    });

    it('should extract object definitions as class kind', () => {
      const code = `
object DatabaseConfig {
  val url = "jdbc:postgresql://localhost/mydb"
}
`;
      const result = extractFromSource('Config.scala', code);
      const obj = result.nodes.find((n) => n.kind === 'class' && n.name === 'DatabaseConfig');
      expect(obj).toBeDefined();
    });

    it('should extract trait definitions as trait kind', () => {
      const code = `
trait Repository[A] {
  def findById(id: String): Option[A]
  def save(entity: A): Unit
}
`;
      const result = extractFromSource('Repository.scala', code);
      const trait_ = result.nodes.find((n) => n.kind === 'trait' && n.name === 'Repository');
      expect(trait_).toBeDefined();
    });
  });

  describe('Method and function extraction', () => {
    it('should extract method definitions inside a class', () => {
      const code = `
class Calculator {
  def add(a: Int, b: Int): Int = a + b
  def divide(a: Double, b: Double): Double = a / b
}
`;
      const result = extractFromSource('Calculator.scala', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.find((m) => m.name === 'add')).toBeDefined();
      expect(methods.find((m) => m.name === 'divide')).toBeDefined();
    });

    it('should extract method signatures', () => {
      const code = `
class Greeter {
  def greet(name: String): String = s"Hello, \${name}!"
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'greet');
      expect(method?.signature).toContain('name: String');
      expect(method?.signature).toContain('String');
    });

    it('should extract top-level function definitions as functions', () => {
      const code = `
def factorial(n: Int): Int = if (n <= 1) 1 else n * factorial(n - 1)
def greet(name: String): String = s"Hello, \${name}!"
`;
      const result = extractFromSource('utils.scala', code);
      const fns = result.nodes.filter((n) => n.kind === 'function');
      expect(fns.find((f) => f.name === 'factorial')).toBeDefined();
      expect(fns.find((f) => f.name === 'greet')).toBeDefined();
    });
  });

  describe('Val and var extraction', () => {
    it('should extract val inside a class as field', () => {
      const code = `
class Config {
  val timeout: Int = 30
  val host: String = "localhost"
}
`;
      const result = extractFromSource('Config.scala', code);
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.find((f) => f.name === 'timeout')).toBeDefined();
      expect(fields.find((f) => f.name === 'host')).toBeDefined();
    });

    it('should extract var inside a class as field', () => {
      const code = `
class Counter {
  var count: Int = 0
}
`;
      const result = extractFromSource('Counter.scala', code);
      const field = result.nodes.find((n) => n.kind === 'field' && n.name === 'count');
      expect(field).toBeDefined();
    });

    it('should extract top-level val as constant', () => {
      const code = `
val MaxConnections: Int = 100
val DefaultTimeout = 30
`;
      const result = extractFromSource('constants.scala', code);
      const consts = result.nodes.filter((n) => n.kind === 'constant');
      expect(consts.find((c) => c.name === 'MaxConnections')).toBeDefined();
    });

    it('should extract top-level var as variable', () => {
      const code = `
var retries: Int = 3
`;
      const result = extractFromSource('state.scala', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'retries');
      expect(v).toBeDefined();
    });

    it('should include type in val/var signature', () => {
      const code = `
class Service {
  val timeout: Int = 30
}
`;
      const result = extractFromSource('Service.scala', code);
      const field = result.nodes.find((n) => n.name === 'timeout');
      expect(field?.signature).toContain('timeout');
      expect(field?.signature).toContain('Int');
    });
  });

  describe('Enum extraction', () => {
    it('should extract enum definitions', () => {
      const code = `
enum Color:
  case Red
  case Green
  case Blue
`;
      const result = extractFromSource('Color.scala', code);
      const enumNode = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Color');
      expect(enumNode).toBeDefined();
    });

    it('should extract enum cases as enum_member', () => {
      const code = `
enum Direction:
  case North
  case South
  case East
  case West
`;
      const result = extractFromSource('Direction.scala', code);
      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.find((m) => m.name === 'North')).toBeDefined();
      expect(members.find((m) => m.name === 'South')).toBeDefined();
      expect(members.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `
type UserId = String
type UserMap = Map[String, String]
`;
      const result = extractFromSource('types.scala', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.find((a) => a.name === 'UserId')).toBeDefined();
      expect(aliases.find((a) => a.name === 'UserMap')).toBeDefined();
    });
  });

  describe('Import extraction', () => {
    it('should extract import declarations', () => {
      const code = `
import scala.collection.mutable.ListBuffer
import scala.concurrent.Future
`;
      const result = extractFromSource('imports.scala', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Visibility modifiers', () => {
    it('should extract private visibility', () => {
      const code = `
class Service {
  private val secret: String = "abc"
  private def helper(): Unit = {}
}
`;
      const result = extractFromSource('Service.scala', code);
      const secretField = result.nodes.find((n) => n.name === 'secret');
      expect(secretField?.visibility).toBe('private');
      const helperMethod = result.nodes.find((n) => n.name === 'helper');
      expect(helperMethod?.visibility).toBe('private');
    });

    it('should extract protected visibility', () => {
      const code = `
class Base {
  protected def helperMethod(): Unit = {}
}
`;
      const result = extractFromSource('Base.scala', code);
      const method = result.nodes.find((n) => n.name === 'helperMethod');
      expect(method?.visibility).toBe('protected');
    });

    it('should default to public visibility', () => {
      const code = `
class Greeter {
  def hello(): Unit = {}
}
`;
      const result = extractFromSource('Greeter.scala', code);
      const method = result.nodes.find((n) => n.name === 'hello');
      expect(method?.visibility).toBe('public');
    });
  });

  describe('Inheritance', () => {
    it('should extract extends relationships', () => {
      const code = `
class AdminUser extends User {
  def adminAction(): Unit = {}
}
`;
      const result = extractFromSource('AdminUser.scala', code);
      const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
      expect(extendsRefs.find((r) => r.referenceName === 'User')).toBeDefined();
    });
  });

  describe('Call extraction', () => {
    it('should extract function call expressions', () => {
      const code = `
def processData(): Unit = {
  val result = computeResult()
  println(result)
}
`;
      const result = extractFromSource('processor.scala', code);
      const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(calls.length).toBeGreaterThan(0);
    });
  });
});

describe('Vue Extraction', () => {
  it('should detect Vue files', () => {
    expect(detectLanguage('App.vue')).toBe('vue');
    expect(detectLanguage('components/Button.vue')).toBe('vue');
    expect(isLanguageSupported('vue')).toBe(true);
  });

  it('should extract component node from a Vue SFC', () => {
    const code = `<template>
  <div>{{ message }}</div>
</template>

<script>
export default {
  data() {
    return { message: 'Hello' };
  }
}
</script>
`;
    const result = extractFromSource('HelloWorld.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('HelloWorld');
    expect(componentNode?.language).toBe('vue');
    expect(componentNode?.isExported).toBe(true);
  });

  it('should extract functions from <script> block', () => {
    const code = `<template>
  <button @click="handleClick">Click</button>
</template>

<script>
function handleClick() {
  console.log('clicked');
}

const count = 0;
</script>
`;
    const result = extractFromSource('Button.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Button');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'handleClick');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');
  });

  it('should extract from <script setup lang="ts"> block', () => {
    const code = `<template>
  <div>{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

function increment(): void {
  count.value++;
}
</script>
`;
    const result = extractFromSource('Counter.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Counter');

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'increment');
    expect(funcNode).toBeDefined();
    expect(funcNode?.language).toBe('vue');

    // All nodes should be marked as vue language
    for (const node of result.nodes) {
      expect(node.language).toBe('vue');
    }
  });

  it('should extract from both <script> and <script setup> blocks', () => {
    const code = `<template>
  <div>{{ msg }}</div>
</template>

<script>
export default {
  name: 'DualScript'
}
</script>

<script setup>
const msg = 'hello';

function greet() {
  return msg;
}
</script>
`;
    const result = extractFromSource('DualScript.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    const greetFunc = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
    expect(greetFunc).toBeDefined();
  });

  it('should create component node for template-only Vue file', () => {
    const code = `<template>
  <div>Static content</div>
</template>
`;
    const result = extractFromSource('Static.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();
    expect(componentNode?.name).toBe('Static');
    expect(componentNode?.language).toBe('vue');

    // Only the component node should exist (no script nodes)
    expect(result.nodes.length).toBe(1);
  });

  it('should create containment edges from component to script nodes', () => {
    const code = `<template>
  <div>{{ value }}</div>
</template>

<script setup lang="ts">
const value = 42;
</script>
`;
    const result = extractFromSource('Contained.vue', code);

    const componentNode = result.nodes.find((n) => n.kind === 'component');
    expect(componentNode).toBeDefined();

    // Should have containment edges from component to child nodes
    const containEdges = result.edges.filter(
      (e) => e.source === componentNode!.id && e.kind === 'contains'
    );
    expect(containEdges.length).toBeGreaterThan(0);
  });
});

describe('Lua Extraction', () => {
  describe('Language detection', () => {
    it('should detect Lua files', () => {
      expect(detectLanguage('init.lua')).toBe('lua');
      expect(detectLanguage('src/util.lua')).toBe('lua');
    });

    it('should report Lua as supported', () => {
      expect(isLanguageSupported('lua')).toBe(true);
      expect(getSupportedLanguages()).toContain('lua');
    });
  });

  describe('Function extraction', () => {
    it('should extract global and local functions', () => {
      const code = `
function configure(opts) return opts end
local function helper(x) return x * 2 end
`;
      const result = extractFromSource('init.lua', code);
      const funcs = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
      expect(funcs).toContain('configure');
      expect(funcs).toContain('helper');
      const configure = result.nodes.find((n) => n.name === 'configure');
      expect(configure?.language).toBe('lua');
      expect(configure?.signature).toBe('(opts)');
    });

    it('should split table/method functions into a receiver and method name', () => {
      const code = `
function M.connect(host, port) return host end
function M:send(data) return self end
`;
      const result = extractFromSource('init.lua', code);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      const connect = methods.find((m) => m.name === 'connect');
      expect(connect?.qualifiedName).toBe('M::connect');
      const send = methods.find((m) => m.name === 'send');
      expect(send?.qualifiedName).toBe('M::send');
    });
  });

  describe('Variable extraction', () => {
    it('should extract local variable declarations', () => {
      const code = `
local M = {}
local count = 0
`;
      const result = extractFromSource('mod.lua', code);
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('M');
      expect(vars).toContain('count');
    });
  });

  describe('Import extraction (require)', () => {
    it('should extract require() in local declarations and bare calls', () => {
      const code = `
local socket = require("socket")
local http = require "resty.http"
require("side.effect")
`;
      const result = extractFromSource('net.lua', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('socket');
      expect(imports).toContain('resty.http');
      expect(imports).toContain('side.effect');

      const ref = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'socket'
      );
      expect(ref).toBeDefined();
    });

    // Regression: the tree-sitter-wasms Lua grammar (ABI 13) corrupts the shared
    // WASM heap under web-tree-sitter 0.25, dropping nested calls/imports on every
    // parse after the first. We vendor the ABI-15 grammar instead — this guards it
    // by extracting several sources in sequence and asserting the LAST still works.
    it('should keep extracting require across many sequential parses', () => {
      let last;
      for (let i = 0; i < 8; i++) {
        last = extractFromSource(`f${i}.lua`, `local m = require("module.${i}")\nreturn m\n`);
      }
      const imports = last!.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('module.7');
    });
  });

  describe('Call extraction', () => {
    it('should record intra-file calls as resolvable references', () => {
      const code = `
local function helper(x) return x end
local function run(y) return helper(y) end
`;
      const result = extractFromSource('calls.lua', code);
      const call = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls' && r.referenceName === 'helper'
      );
      expect(call).toBeDefined();
    });
  });
});

// =============================================================================
// Luau (typed superset of Lua — https://luau.org)
// =============================================================================

describe('Luau Extraction', () => {
  describe('Language detection', () => {
    it('should detect Luau files', () => {
      expect(detectLanguage('init.luau')).toBe('luau');
      expect(detectLanguage('src/Client.luau')).toBe('luau');
    });

    it('should report Luau as supported', () => {
      expect(isLanguageSupported('luau')).toBe(true);
      expect(getSupportedLanguages()).toContain('luau');
    });
  });

  describe('Type aliases', () => {
    it('should extract `type` and `export type` definitions', () => {
      const code = `
export type Vector = { x: number, y: number }
type Handler = (msg: string) -> boolean
`;
      const result = extractFromSource('types.luau', code);
      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      const vector = aliases.find((a) => a.name === 'Vector');
      expect(vector).toBeDefined();
      expect(vector?.isExported).toBe(true);
      const handler = aliases.find((a) => a.name === 'Handler');
      expect(handler).toBeDefined();
      expect(handler?.isExported).toBe(false);
    });
  });

  describe('Typed functions and methods', () => {
    it('should capture typed signatures and split methods by receiver', () => {
      const code = `
function configure(opts: { debug: boolean }): boolean
	return opts.debug
end
function Client:fetch(path: string): Response
	return path
end
`;
      const result = extractFromSource('client.luau', code);
      const configure = result.nodes.find((n) => n.kind === 'function' && n.name === 'configure');
      expect(configure?.language).toBe('luau');
      expect(configure?.signature).toBe('(opts: { debug: boolean }): boolean');
      const fetch = result.nodes.find((n) => n.kind === 'method' && n.name === 'fetch');
      expect(fetch?.qualifiedName).toBe('Client::fetch');
    });
  });

  describe('Imports and variables', () => {
    it('should extract string and Roblox instance-path require imports', () => {
      const code = `
local http = require("http")
local Signal = require(script.Parent.Signal)
local count = 0
`;
      const result = extractFromSource('mod.luau', code);
      const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(imports).toContain('http'); // string require
      expect(imports).toContain('Signal'); // Roblox instance-path require
      const vars = result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
      expect(vars).toContain('count');
    });
  });
});
