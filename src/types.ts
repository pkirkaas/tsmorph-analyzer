/** Represents a TypeScript property in an interface or type */
export interface TypeProperty {
  name: string;
  type: TypeDefinition;
  optional: boolean;
  readonly?: boolean;
}

/** Represents a TypeScript type definition */
export interface TypeDefinition {
  kind: 'primitive' | 'reference' | 'union' | 'intersection' | 'generic' | 'array' | 
        'tuple' | 'mapped' | 'circular';
  name: string;
  genericParameters?: TypeDefinition[];
  members?: TypeProperty[];
  unionMembers?: TypeDefinition[];
  srcFiles?: string[];  
  intersectionMembers?: TypeDefinition[];
  arrayElementType?: TypeDefinition;
  tupleElements?: TypeDefinition[];
  resolved?: TypeDefinition;  // For resolved reference types
  constraints?: TypeDefinition[];  // For generic constraints
  // For mapped types
  mappedType?: {
    keyType: TypeDefinition;
    valueType: TypeDefinition;
    optional?: boolean;
    readonly?: boolean;
  };
  // For circular references
  circularReference?: string;
  typeParameters?: TypeDefinition[];
}

/** Represents the final analysis output */
export interface AnalysisResult {
  interfaces: Record<string, InterfaceDefinition>;
  types: Record<string, TypeDefinition>;
}

/** Represents a TypeScript interface definition */
export interface InterfaceDefinition {
  name: string;
  genericParameters?: TypeDefinition[];
  properties: TypeProperty[];
  srcFiles?: string[];  
  extends?: string[];
  resolved?: InterfaceDefinition;
  constraints?: TypeDefinition[];  // For generic constraints
}
