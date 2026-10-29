"""A stand-in for torch in the harness's tests: only what the junior's verifier asks of it."""


class cuda:
    @staticmethod
    def is_available():
        return True
