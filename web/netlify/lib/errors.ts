export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** What to tell someone whose Netlify variable isn't reaching the functions. */
export const missingVar = (name: string) =>
  `${name} is not set - in Netlify, add it under Site configuration > Environment `
  + "variables with the Functions scope and a Production value, then redeploy";

export function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new HttpError(500, missingVar(name));
  return value;
}
