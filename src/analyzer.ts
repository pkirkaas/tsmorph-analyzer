import {
  Project,
  TypeAliasDeclaration,
  InterfaceDeclaration,
  Type,
  Node,
  TypeParameterDeclaration,
  Symbol as TSMorphSymbol,
  ts,
} from 'ts-morph';
import { TypeDefinition, InterfaceDefinition, AnalysisResult, TypeProperty } from './types.js';
import path from 'path';

export class TypeScriptAnalyzer {
  private project: Project;
  private ignoredDirs = ['node_modules', 'dist', '.git', 'git-hooks', 'deprecated', 'logs', 'tmp'];
  private typeCache = new Map<string, TypeDefinition>();
  private interfaceCache = new Map<string, InterfaceDefinition>();
  private processingTypes = new Set<string>();

  constructor(private basePath: string) {
    try {
      this.project = new Project({
        tsConfigFilePath: path.join(basePath, 'tsconfig.json'),
        skipAddingFilesFromTsConfig: true,
      });
    } catch (error) {
      throw new Error(`Failed to initialize TypeScript project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public analyze(): AnalysisResult {
    try {
      this.loadSourceFiles();
      return {
        interfaces: this.analyzeInterfaces(),
        types: this.analyzeTypes(),
      };
    } catch (error) {
      throw new Error(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private loadSourceFiles(): void {
    try {
      const files = this.project.addSourceFilesAtPaths([
        path.join(this.basePath, '**/*.ts'),
        path.join(this.basePath, '**/*.tsx'),
        `!${path.join(this.basePath, '**/*.d.ts')}`,
        ...this.ignoredDirs.map(ignored => `!${path.join(this.basePath, ignored, '**/*')}`)
      ]);

      if (files.length === 0) {
        throw new Error('No TypeScript files found in the specified directory');
      }
    } catch (error) {
      throw new Error(`Failed to load source files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private analyzeTypeParameter(typeParam: TypeParameterDeclaration): TypeDefinition {
    try {
      const constraint = typeParam.getConstraint();
      const defaultType = typeParam.getDefault();

      const typeDefinition: TypeDefinition = {
        kind: 'generic',
        name: typeParam.getText(),
      };

      if (constraint) {
        typeDefinition.constraints = [this.analyzeType(constraint.getType())];
      }

      if (defaultType) {
        typeDefinition.resolved = this.analyzeType(defaultType.getType());
      }

      return typeDefinition;
    } catch (error) {
      throw new Error(`Failed to analyze type parameter ${typeParam.getText()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private analyzeMappedType(type: Type, node: Node<ts.MappedTypeNode>): TypeDefinition {
    try {
        const typeParameter = node.getFirstChildByKind(ts.SyntaxKind.TypeParameter);
        if (!typeParameter) {
            throw new Error('Missing type parameter in mapped type');
        }

        // Get the type node using the correct syntax kind
        const typeNode = node.getChildrenOfKind(ts.SyntaxKind.TypeLiteral)[0] ||
                        node.getChildrenOfKind(ts.SyntaxKind.UnionType)[0] ||
                        node.getChildrenOfKind(ts.SyntaxKind.IntersectionType)[0] ||
                        node.getChildrenOfKind(ts.SyntaxKind.ArrayType)[0] ||
                        node.getChildrenOfKind(ts.SyntaxKind.TypeReference)[0];

        if (!typeNode) {
            throw new Error('Missing type node in mapped type');
        }

        const mappedType: TypeDefinition = {
            kind: 'mapped',
            name: type.getText(),
            mappedType: {
                keyType: this.analyzeType(typeParameter.getType()),
                valueType: this.analyzeType(typeNode.getType()),
                optional: node.getFirstChildByKind(ts.SyntaxKind.QuestionToken) !== undefined,
                readonly: node.getFirstChildByKind(ts.SyntaxKind.ReadonlyKeyword) !== undefined,
            }
        };

        return mappedType;
    } catch (error) {
        throw new Error(`Failed to analyze mapped type: ${error instanceof Error ? error.message : String(error)}`);
    }
}


  private analyzeTypeAlias(typeAlias: TypeAliasDeclaration): TypeDefinition {
    const name = typeAlias.getName();

    try {
      if (this.processingTypes.has(name)) {
        return {
          kind: 'circular',
          name,
          circularReference: name
        };
      }

      if (this.typeCache.has(name)) {
        return this.typeCache.get(name)!;
      }

      this.processingTypes.add(name);

      const typeNode = typeAlias.getTypeNode();
      if (!typeNode) {
        throw new Error(`Type alias ${name} has no type node`);
      }

      const typeDefinition: TypeDefinition = {
        kind: 'reference',
        name,
      };

      const typeParams = typeAlias.getTypeParameters();
      if (typeParams.length > 0) {
        typeDefinition.genericParameters = typeParams.map(param => 
          this.analyzeTypeParameter(param)
        );
      }

      if (Node.isMappedTypeNode(typeNode)) {
        Object.assign(typeDefinition, this.analyzeMappedType(typeAlias.getType(), typeNode));
      } else {
        Object.assign(typeDefinition, this.analyzeType(typeAlias.getType()));
      }

      this.typeCache.set(name, typeDefinition);
      this.processingTypes.delete(name);
      
      return typeDefinition;
    } catch (error) {
      this.processingTypes.delete(name);
      throw new Error(`Failed to analyze type alias ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private analyzeInterface(interfaceDecl: InterfaceDeclaration): InterfaceDefinition {
    const name = interfaceDecl.getName();

    try {
      if (this.interfaceCache.has(name)) {
        return this.interfaceCache.get(name)!;
      }

      const definition: InterfaceDefinition = {
        name,
        properties: [],
        extends: interfaceDecl.getExtends().map(ext => ext.getText()),
      };

      const typeParams = interfaceDecl.getTypeParameters();
      if (typeParams.length > 0) {
        definition.genericParameters = typeParams.map(param => 
          this.analyzeTypeParameter(param)
        );
      }

      definition.properties = interfaceDecl.getProperties().map(prop => ({
        name: prop.getName(),
        type: this.analyzeType(prop.getType()),
        optional: prop.hasQuestionToken(),
        readonly: prop.isReadonly(),
      }));

      this.interfaceCache.set(name, definition);

      if (definition.extends && definition.extends.length > 0) {
        const resolvedProperties = [...definition.properties];
        
        for (const extendedInterface of definition.extends) {
          const baseInterface = this.project.getSourceFiles()
            .map(sf => sf.getInterface(extendedInterface))
            .find(i => i !== undefined);
            
          if (baseInterface) {
            const baseDefinition = this.analyzeInterface(baseInterface);
            resolvedProperties.push(...baseDefinition.properties);
          }
        }

        definition.resolved = {
          ...definition,
          properties: resolvedProperties,
        };
      }

      return definition;
    } catch (error) {
      throw new Error(`Failed to analyze interface ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private analyzeType(type: Type): TypeDefinition {
    const typeText = type.getText();

    try {
      if (this.processingTypes.has(typeText)) {
        return {
          kind: 'circular',
          name: typeText,
          circularReference: typeText
        };
      }

      this.processingTypes.add(typeText);

      let typeDefinition: TypeDefinition;

      if (type.isUnion()) {
        typeDefinition = {
          kind: 'union',
          name: typeText,
          unionMembers: type.getUnionTypes().map(t => this.analyzeType(t)),
        };
      } else if (type.isIntersection()) {
        typeDefinition = {
          kind: 'intersection',
          name: typeText,
          intersectionMembers: type.getIntersectionTypes().map(t => this.analyzeType(t)),
        };
      } else if (type.isArray()) {
        const elementType = type.getArrayElementTypeOrThrow();
        typeDefinition = {
          kind: 'array',
          name: typeText,
          arrayElementType: this.analyzeType(elementType),
        };
      } else if (type.isTuple()) {
        typeDefinition = {
          kind: 'tuple',
          name: typeText,
          tupleElements: type.getTupleElements().map(t => this.analyzeType(t)),
        };
      } else if (type.isString() || type.isNumber() || type.isBoolean() || 
                 type.isNull() || type.isUndefined()) {
        typeDefinition = {
          kind: 'primitive',
          name: typeText,
        };
      } else if (type.isObject()) {
        const properties: TypeProperty[] = [];
        
        for (const prop of type.getProperties()) {
          const valueDeclaration = prop.getValueDeclarationOrThrow();
          const propType = prop.getTypeAtLocation(valueDeclaration);
          properties.push({
            name: prop.getName(),
            type: this.analyzeType(propType),
            optional: prop.isOptional(),
          });
        }

        typeDefinition = {
          kind: 'reference',
          name: typeText,
          members: properties,
        };

        const typeArgs = type.getTypeArguments();
        if (typeArgs.length > 0) {
          typeDefinition.typeParameters = typeArgs.map(t => this.analyzeType(t));
        }
      } else {
        typeDefinition = {
          kind: 'reference',
          name: typeText,
        };
      }

      this.processingTypes.delete(typeText);
      return typeDefinition;
    } catch (error) {
      this.processingTypes.delete(typeText);
      throw new Error(`Failed to analyze type ${typeText}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private analyzeTypes(): Record<string, TypeDefinition> {
    const types: Record<string, TypeDefinition> = {};
    
    for (const sourceFile of this.project.getSourceFiles()) {
      for (const typeAlias of sourceFile.getTypeAliases()) {
        const typeName = typeAlias.getName();
        try {
          types[typeName] = this.analyzeTypeAlias(typeAlias);
        } catch (error) {
          console.error(`Error analyzing type ${typeName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return types;
  }

  private analyzeInterfaces(): Record<string, InterfaceDefinition> {
    const interfaces: Record<string, InterfaceDefinition> = {};
    
    for (const sourceFile of this.project.getSourceFiles()) {
      for (const interfaceDecl of sourceFile.getInterfaces()) {
        const interfaceName = interfaceDecl.getName();
        try {
          interfaces[interfaceName] = this.analyzeInterface(interfaceDecl);
        } catch (error) {
          console.error(`Error analyzing interface ${interfaceName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return interfaces;
  }
}
