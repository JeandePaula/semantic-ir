import { isDeepStrictEqual } from 'node:util';

export function compare(expected, actual, path='$') {
  if (isDeepStrictEqual(expected,actual)) return [];
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object' ||
      Array.isArray(expected)!==Array.isArray(actual)) return [{path,expected,actual}];
  const keys = new Set([...Object.keys(expected),...Object.keys(actual)]);
  return [...keys].flatMap(key => compare(expected[key],actual[key],path+'.'+key));
}

export function evaluate(text,expected) {
  let actual;
  try { actual=JSON.parse(text.trim()); }
  catch { return {passed:false,validJson:false,sections:{},differences:[{path:'$',error:'invalid_json'}]}; }
  const differences=compare(expected,actual);
  return {passed:differences.length===0,validJson:true,
    sections:Object.fromEntries(Object.keys(expected).map(key=>[key,isDeepStrictEqual(actual?.[key],expected[key])])),differences};
}
