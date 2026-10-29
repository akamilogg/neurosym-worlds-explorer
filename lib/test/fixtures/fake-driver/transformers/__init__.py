"""A character tokenizer standing in for transformers.AutoTokenizer in the harness's tests: one token per character."""


class _Tok:
    def __call__(self, s, add_special_tokens=False):
        return {"input_ids": [ord(c) for c in s]}

    eos_token_id = 10

    def decode(self, ids, skip_special_tokens=False):
        return "".join(chr(int(i)) for i in ids if int(i) > 0)

    def apply_chat_template(self, messages, tools=None, add_generation_prompt=True, enable_thinking=False, tokenize=True):
        return [ord(c) for c in chr(10).join(m["content"] for m in messages)]


class AutoTokenizer:
    @staticmethod
    def from_pretrained(path):
        return _Tok()
