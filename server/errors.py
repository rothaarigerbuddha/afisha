"""Ошибки API: {error, hint}. ApiError → HTTP 400 с человеческим текстом и подсказкой."""

class ApiError(Exception):
    def __init__(self, msg, hint=''):
        super().__init__(msg)
        self.msg, self.hint = msg, hint

    def to_json(self):
        d = {'error': self.msg}
        if self.hint: d['hint'] = self.hint
        return d
