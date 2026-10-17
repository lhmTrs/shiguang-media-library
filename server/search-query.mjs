export function searchTerms(value = "") {
  const terms = [], seen = new Set();
  const add = value => {
    const term = value.trim(), key = term.toLocaleLowerCase();
    if (term && !seen.has(key)) { terms.push(term); seen.add(key); }
  };
  let word = "", quote = "";
  for (const char of String(value)) {
    if (quote) {
      if (char === quote) { add(word); word = ""; quote = ""; }
      else word += char;
    } else if (char === '"' || char === '“') {
      add(word); word = ""; quote = char === '“' ? '”' : '"';
    } else if (/\s/u.test(char)) { add(word); word = ""; }
    else word += char;
  }
  add(word);
  return terms;
}

export function joinSearchTerms(terms) {
  return terms.map(term => /\s/u.test(term) ? '"' + term + '"' : term).join(" ");
}
