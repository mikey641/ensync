export class InvalidJsonResponseError extends SyntaxError {
  code: 'invalid_json_response'
  status: number | null
}

export function readJsonResponse(response: Response): Promise<unknown>
