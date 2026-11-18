// ANSI escape sequences emitted by colorized commands (CSI, OSC, and the
// single-character forms). The model must never see them; the UI renders them
// as styles. FORCE_COLOR is set for Bash tool sessions so commands actually
// emit color when stdout is a pipe.
const ANSI_ESCAPE_SEQUENCE =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_SEQUENCE, "");
}
