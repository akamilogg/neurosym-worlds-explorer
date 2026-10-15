"""Whether three of the numbers sum to zero.

Reads input.txt (the count n on the first line, then n integers separated by spaces) and writes
out.txt: "yes" if three of them, at three different positions, sum to zero, and "no" otherwise.
"""


def main():
    lines = open("input.txt", encoding="utf-8").read().split("\n")
    n = int(lines[0])
    numbers = [int(x) for x in lines[1].split()][:n]
    answer = "no"
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                if numbers[i] + numbers[j] + numbers[k] == 0:
                    answer = "yes"
                    break
            if answer == "yes":
                break
        if answer == "yes":
            break
    open("out.txt", "w", encoding="utf-8").write(answer + "\n")


main()
