// Single entry point for all CodeMirror imports.
// Vite pre-bundles this as one chunk so every package shares
// the same @codemirror/state instance — no "multiple instances" error.
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
export { EditorState } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
export { sql } from '@codemirror/lang-sql';
export { oneDark } from '@codemirror/theme-one-dark';
