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
import fs from 'fs';

export class TypeScriptAnalyzer {
  project: Project;
  ignoredDirs = ['node_modules', 'dist', '.git', 'git-hooks', 'deprecated', 'logs', 'tmp'];
  typeCache = new Map<string, TypeDefinition>();
  interfaceCache = new Map<string, InterfaceDefinition>();
  processingTypes = new Set<string>();

            //const sourceFiles = this.project.getSourceFiles();
      constructor(private basePath: string) {
        try {
            this.project = new Project({
                tsConfigFilePath: path.join(basePath, 'tsconfig.json'),
                skipAddingFilesFromTsConfig: true,
            });
            this.loadSourceFiles();
            
            // Validate project immediately
            const validationIssues = this.validateProject();
            if (validationIssues.length > 0) {
                throw new Error(`Project validation failed:\n${validationIssues.join('\n')}`);
            }
            /*
            */
        } catch (error) {
            throw new Error(`\nFailed to initialize TypeScript project: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
  /*
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
    */

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
          circularReference: name,
          srcFiles: [typeAlias.getSourceFile().getFilePath()],
        };
      }

//      if (this.typeCache.has(name)) {
//        return this.typeCache.get(name)!;
//      }

        if (this.typeCache.has(name)) {
            const cached = this.typeCache.get(name)!;
            // Add the current file to srcFiles if it's not already there
            const currentFile = typeAlias.getSourceFile().getFilePath();
            if (!cached.srcFiles.includes(currentFile)) {
                cached.srcFiles.push(currentFile);
            }
            return cached;
        }


      this.processingTypes.add(name);

      const typeNode = typeAlias.getTypeNode();
      if (!typeNode) {
        throw new Error(`Type alias ${name} has no type node`);
      }

      const typeDefinition: TypeDefinition = {
        kind: 'reference',
        name,
        srcFiles: [typeAlias.getSourceFile().getFilePath()],
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
      //if (this.interfaceCache.has(name)) {
       // return this.interfaceCache.get(name)!;
      //}
      if (this.interfaceCache.has(name)) {
        const cached = this.interfaceCache.get(name)!;
        // Add the current file to srcFiles if it's not already there
        const currentFile = interfaceDecl.getSourceFile().getFilePath();
        if (!cached.srcFiles.includes(currentFile)) {
            cached.srcFiles.push(currentFile);
        }
        return cached;
    }

      const definition: InterfaceDefinition = {
        name,
        properties: [],
        extends: interfaceDecl.getExtends().map(ext => ext.getText()),
                    srcFiles: [interfaceDecl.getSourceFile().getFilePath()],
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

  // New methods for including file paths


/**
 * Finds all declarations of a specific type across the project
 * @param typeName Name of the type to find
 * @returns Array of file paths containing the type declaration
 */
public findTypeDeclarations(typeName: string): string[] {
  const declarations: string[] = [];
  
  this.project.getSourceFiles().forEach(sourceFile => {
      const typeAlias = sourceFile.getTypeAlias(typeName);
      if (typeAlias) {
          declarations.push(sourceFile.getFilePath());
      }
  });

  return declarations;
}

/**
* Finds all declarations of a specific interface across the project
* @param interfaceName Name of the interface to find
* @returns Array of file paths containing the interface declaration
*/
public findInterfaceDeclarations(interfaceName: string): string[] {
  const declarations: string[] = [];
  
  this.project.getSourceFiles().forEach(sourceFile => {
      const interfaceDecl = sourceFile.getInterface(interfaceName);
      if (interfaceDecl) {
          declarations.push(sourceFile.getFilePath());
      }
  });

  return declarations;
}



/**
 * Returns statistics about type and interface declarations
 * @returns Object containing declaration statistics
 */
public getDeclarationStats(): {
  typesWithMultipleDeclarations: Array<{ name: string, files: string[] }>;
  interfacesWithMultipleDeclarations: Array<{ name: string, files: string[] }>;
} {
  const typeMap = new Map<string, Set<string>>();
  const interfaceMap = new Map<string, Set<string>>();

  this.project.getSourceFiles().forEach(sourceFile => {
      const filePath = sourceFile.getFilePath();
      
      // Collect type declarations
      sourceFile.getTypeAliases().forEach(type => {
          const name = type.getName();
          if (!typeMap.has(name)) {
              typeMap.set(name, new Set());
          }
          typeMap.get(name)!.add(filePath);
      });

      // Collect interface declarations
      sourceFile.getInterfaces().forEach(int => {
          const name = int.getName();
          if (!interfaceMap.has(name)) {
              interfaceMap.set(name, new Set());
          }
          interfaceMap.get(name)!.add(filePath);
      });
  });

  return {
      typesWithMultipleDeclarations: Array.from(typeMap.entries())
          .filter(([_, files]) => files.size > 1)
          .map(([name, files]) => ({ name, files: Array.from(files) })),
      interfacesWithMultipleDeclarations: Array.from(interfaceMap.entries())
          .filter(([_, files]) => files.size > 1)
          .map(([name, files]) => ({ name, files: Array.from(files) }))
  };
}




  // New testing methods


    /**
     * Validates the project structure and configuration
     * @returns Array of validation messages
     */
    public validateProject(): string[] {
        const validationMessages: string[] = [];
        
        try {
            // Verify tsconfig.json
            const compilerOptions = this.project.getCompilerOptions();
            if (!compilerOptions) {
                validationMessages.push('No tsconfig.json found or invalid configuration');
            }

            // Verify project directory exists
            if (!fs.existsSync(this.basePath)) {
                validationMessages.push(`Project directory not found: ${this.basePath}`);
            }

            // Load and verify source files
            const sourceFiles = this.listSourceFiles();
            if (sourceFiles.length === 0) {
                validationMessages.push('No TypeScript source files found in project');
            }

            // Verify each source file
            sourceFiles.forEach(filePath => {
                try {
                    const sourceFile = this.project.getSourceFile(filePath);
                    if (!sourceFile) {
                        validationMessages.push(`Failed to load source file: ${filePath}`);
                        return;
                    }

                    // Check if file can be parsed
                    sourceFile.getFullText();
                    
                    // Check for syntax errors
                    const diagnostics = sourceFile.getPreEmitDiagnostics();
                    if (diagnostics.length > 0) {
                        validationMessages.push(
                            `Syntax errors in ${filePath}:\n${
                                diagnostics.map(d => `  - ${d.getMessageText()}`).join('\n')
                            }`
                        );
                    }
                } catch (error) {
                    validationMessages.push(`Error processing ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
                }
            });

        } catch (error) {
            validationMessages.push(`Project validation failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        return validationMessages;
    }

    /**
     * Returns array of all TypeScript source file paths that will be processed
     * @returns Array of file paths relative to project root
     */
    public listSourceFiles(): string[] {
        try {
            const sourceFiles = this.project.getSourceFiles();
            return sourceFiles
            /*
                .filter(file => {
                    const filePath = file.getFilePath();
                    return !this.ignoredDirs.some(dir => 
                        filePath.includes(`${path.sep}${dir}${path.sep}`) || 
                        filePath.endsWith(`.d.ts`)
                    );
                })
                    */
                .map(file => file.getFilePath());
        } catch (error) {
            throw new Error(`Failed to list source files: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Returns detailed statistics about the project
     * @returns Object containing project statistics
     */
    public getProjectStats(): {
        fileCount: number;
        interfaceCount: number;
        typeCount: number;
        filesWithInterfaces: string[];
        filesWithTypes: string[];
        genericInterfaceCount: number;
        genericTypeCount: number;
    } {
        const stats = {
            fileCount: 0,
            interfaceCount: 0,
            typeCount: 0,
            filesWithInterfaces: [] as string[],
            filesWithTypes: [] as string[],
            genericInterfaceCount: 0,
            genericTypeCount: 0,
        };

        this.project.getSourceFiles().forEach(sourceFile => {
            const filePath = sourceFile.getFilePath();
            if (this.ignoredDirs.some(dir => filePath.includes(`${path.sep}${dir}${path.sep}`))) {
                return;
            }

            stats.fileCount++;

            const interfaces = sourceFile.getInterfaces();
            if (interfaces.length > 0) {
                stats.interfaceCount += interfaces.length;
                stats.filesWithInterfaces.push(filePath);
                stats.genericInterfaceCount += interfaces.filter(i => 
                    i.getTypeParameters().length > 0
                ).length;
            }

            const types = sourceFile.getTypeAliases();
            if (types.length > 0) {
                stats.typeCount += types.length;
                stats.filesWithTypes.push(filePath);
                stats.genericTypeCount += types.filter(t => 
                    t.getTypeParameters().length > 0
                ).length;
            }
        });

        return stats;
    }

    /**
     * Returns detailed information about a specific interface
     * @param interfaceName Name of the interface to inspect
     * @returns Detailed interface information or null if not found
     */
    public inspectInterface(interfaceName: string): {
        name: string;
        filePath: string;
        properties: Array<{
            name: string;
            type: string;
            optional: boolean;
            readonly: boolean;
        }>;
        extends: string[];
        genericParams: string[];
        isExported: boolean;
    } | null {
        for (const sourceFile of this.project.getSourceFiles()) {
            const interfaceDecl = sourceFile.getInterface(interfaceName);
            if (interfaceDecl) {
                return {
                    name: interfaceDecl.getName(),
                    filePath: sourceFile.getFilePath(),
                    properties: interfaceDecl.getProperties().map(p => ({
                        name: p.getName(),
                        type: p.getType().getText(),
                        optional: p.hasQuestionToken(),
                        readonly: p.isReadonly(),
                    })),
                    extends: interfaceDecl.getExtends().map(e => e.getText()),
                    genericParams: interfaceDecl.getTypeParameters().map(p => p.getText()),
                    isExported: interfaceDecl.isExported(),
                };
            }
        }
        return null;
    }

    /**
     * Returns detailed information about a specific type alias
     * @param typeName Name of the type to inspect
     * @returns Detailed type information or null if not found
     */
    public inspectType(typeName: string): {
        name: string;
        filePath: string;
        rawText: string;
        genericParams: string[];
        kind: string;
        isExported: boolean;
        isUnion: boolean;
        isIntersection: boolean;
    } | null {
        for (const sourceFile of this.project.getSourceFiles()) {
            const typeAlias = sourceFile.getTypeAlias(typeName);
            if (typeAlias) {
                const type = typeAlias.getType();
                return {
                    name: typeAlias.getName(),
                    filePath: sourceFile.getFilePath(),
                    rawText: typeAlias.getTypeNode()?.getText() ?? '',
                    genericParams: typeAlias.getTypeParameters().map(p => p.getText()),
                    kind: ts.SyntaxKind[typeAlias.getKind()],
                    isExported: typeAlias.isExported(),
                    isUnion: type.isUnion(),
                    isIntersection: type.isIntersection(),
                };
            }
        }
        return null;
    }

    /**
     * Returns all circular type references found in the project
     * @returns Map of type names to their circular references
     */
    public findCircularReferences(): Map<string, string[]> {
        const circularRefs = new Map<string, string[]>();
        
        this.project.getSourceFiles().forEach(sourceFile => {
            // Check type aliases
            sourceFile.getTypeAliases().forEach(type => {
                const refs = this.findTypeReferences(type.getType(), new Set());
                if (refs.has(type.getName())) {
                    circularRefs.set(type.getName(), Array.from(refs));
                }
            });

            // Check interfaces
            sourceFile.getInterfaces().forEach(int => {
                const refs = this.findInterfaceReferences(int, new Set());
                if (refs.has(int.getName())) {
                    circularRefs.set(int.getName(), Array.from(refs));
                }
            });
        });

        return circularRefs;
    }

    private findTypeReferences(type: Type, seen: Set<string>): Set<string> {
        const refs = new Set<string>();
        const typeName = type.getText();
        
        if (seen.has(typeName)) {
            return refs;
        }
        seen.add(typeName);

        if (type.isObject()) {
            type.getProperties().forEach(prop => {
                const propType = prop.getValueDeclaration()?.getType();
                if (propType) {
                    this.findTypeReferences(propType, seen).forEach(ref => refs.add(ref));
                }
            });
        }

        return refs;
    }

    private findInterfaceReferences(int: InterfaceDeclaration, seen: Set<string>): Set<string> {
        const refs = new Set<string>();
        const intName = int.getName();
        
        if (seen.has(intName)) {
            return refs;
        }
        seen.add(intName);

        int.getProperties().forEach(prop => {
            const propType = prop.getType();
            this.findTypeReferences(propType, seen).forEach(ref => refs.add(ref));
        });

        return refs;
    }

    // More Testing Methods


/**
 * Returns count of interfaces found in each source file
 * @returns Map of file paths to interface counts
 */
public countInterfacesPerFile(): Map<string, number> {
    const counts = new Map<string, number>();
    
    this.project.getSourceFiles().forEach(sourceFile => {
        const interfaces = sourceFile.getInterfaces();
        if (interfaces.length > 0) {
            counts.set(sourceFile.getFilePath(), interfaces.length);
        }
    });
    
    return counts;
}

/**
 * Returns count of type aliases found in each source file
 * @returns Map of file paths to type alias counts
 */
public countTypesPerFile(): Map<string, number> {
    const counts = new Map<string, number>();
    
    this.project.getSourceFiles().forEach(sourceFile => {
        const types = sourceFile.getTypeAliases();
        if (types.length > 0) {
            counts.set(sourceFile.getFilePath(), types.length);
        }
    });
    
    return counts;
}

/**
 * Lists all interface names found in the project
 * @returns Array of interface names
 */
public listInterfaceNames(): string[] {
    const names: string[] = [];
    this.project.getSourceFiles().forEach(sourceFile => {
        sourceFile.getInterfaces().forEach(int => {
            names.push(int.getName());
        });
    });
    return names;
}

/**
 * Lists all type alias names found in the project
 * @returns Array of type alias names
 */
public listTypeNames(): string[] {
    const names: string[] = [];
    this.project.getSourceFiles().forEach(sourceFile => {
        sourceFile.getTypeAliases().forEach(type => {
            names.push(type.getName());
        });
    });
    return names;
}




}
