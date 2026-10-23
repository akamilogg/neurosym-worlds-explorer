"""Whether three of the numbers sum to zero.

Reads input.txt (the count n on the first line, then n integers separated by spaces) and writes
out.txt: "yes" if three of them, at three different positions, sum to zero, and "no" otherwise.
"""


def main():
    lines = open("input.txt", encoding="utf-8").read().split("\n")
    n = int(lines[0])
    numbers = sorted(int(x) for x in lines[1].split()[:n])
    answer = "no"
    for i in range(n - 2):
        lo, hi = i + 1, n - 1
        while lo < hi:
            total = numbers[i] + numbers[lo] + numbers[hi]
            if total == 0:
                answer = "yes"
                break
            if total < 0:
                lo += 1
            else:
                hi -= 1
        if answer == "yes":
            break
    open("out.txt", "w", encoding="utf-8").write(answer + "\n")


main()
