export type Field = {key:string;type:'text'|'textarea'|'number'|'select'|'multiselect';required:boolean;default:string|string[];options?:string[];help?:string};
export type Definition = {name:string;description:string;category:string;body:string;fields:Field[]};
export type Values = Record<string,string|string[]>;
export const FIELD_TYPES: string[];
export function definition(input:unknown):Definition;
export function defaults(t:Definition):Values;
export function references(body:string):string[];
export function canonical(value:unknown):string;
export function compile(input:Definition,values?:Values):{values:Values;errors:string[];segments:{text:string;variable?:boolean;missing?:boolean}[];prompt:string};
