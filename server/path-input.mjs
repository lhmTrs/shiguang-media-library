import path from 'node:path';
// Preserve unquoted names (including POSIX whitespace); strip only an outer pair.
export function unquotePath(input) {
 if(typeof input!=='string')return input;
 const value=input.trim(),quote=value[0];
 return value.length>=2&&['"',"'"].includes(quote)&&value.at(-1)===quote?value.slice(1,-1):input;
}
// Escape BOTH the path and separator: a Windows backslash is LIKE's escape byte.
export function descendantLike(directory,separator=path.sep) {
 const prefix=directory.endsWith(separator)?directory:directory+separator;
 return prefix.replace(/[\\%_]/g,'\\$&')+'%';
}
