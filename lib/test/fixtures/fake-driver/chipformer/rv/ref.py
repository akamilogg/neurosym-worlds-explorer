class Machine:
    @classmethod
    def from_program(cls, program):
        m = cls()
        m.program = program
        return m
