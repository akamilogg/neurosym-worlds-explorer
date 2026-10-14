"""Deduplicate records by key, keep those whose tag is well formed, and write them ranked.

Reads input.csv (key,value,tag) and writes out.csv: one row per key (its first record),
only rows whose tag is letters followed by digits, ordered by value (highest first),
then by key.
"""
import re


def well_formed(tag):
    return re.fullmatch(r"[a-z]+[0-9]+", tag) is not None


def main():
    text = open("input.csv", encoding="utf-8").read()
    lines = text.split("\n")
    seen = []
    kept = []
    for line in lines[1:]:
        if not line:
            continue
        key, value, tag = line.split(",")
        if key in seen:
            continue
        seen.append(key)
        if not well_formed(tag):
            continue
        kept.append((int(value), key, tag))
        kept.sort(key=lambda r: (-r[0], r[1]))
    out = "key,value,tag\n"
    for value, key, tag in kept:
        out = out + key + "," + str(value) + "," + tag + "\n"
    open("out.csv", "w", encoding="utf-8").write(out)


main()
