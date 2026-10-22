"""The hand-labelling workbook for the LLM evaluation (BE-15, D-028).

    pnpm --filter @bookie/api llm-eval sheet   # the evidence, from the dataset (local only)
    pnpm eval label-sheet                      # this workbook, next to it

One row per evaluation book with dropdowns for the trait vocabularies, the
reviews the models read on a second sheet, and the instructions of
eval/llm/traits-instructions.md in plain words. The workbook holds review
text, so it stays in data/derived/ and is never committed (D-004); only the
labels are imported back.
"""

import html
import json
import re
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.worksheet.datavalidation import DataValidation


def clean(text):
    """Plain text, as the models see it: no HTML tags or entities, no characters Excel refuses."""
    if not isinstance(text, str):
        return text
    text = html.unescape(re.sub(r"<br\s*/?>|</p>", "\n", text, flags=re.I))
    text = re.sub(r"<[^>]+>", "", text)
    return ILLEGAL_CHARACTERS_RE.sub("", text).strip()

PACE = ["slow", "moderate", "fast", "unknown"]
TONE = ["dark", "light", "serious", "humorous", "hopeful", "melancholic", "tense", "romantic", "unknown"]
INTENSITY = ["low", "moderate", "high", "unknown"]
THEMES = [
    "love and romance", "family", "friendship", "coming of age", "grief and loss", "war and conflict",
    "identity", "power and politics", "crime and justice", "survival", "faith and religion",
    "social class and inequality", "adventure and quest", "mental health", "addiction", "violence", "tragedy",
]

FONT = "Arial"
BASE = Font(name=FONT, size=10)
BOLD = Font(name=FONT, size=10, bold=True)
HEAD = Font(name=FONT, size=10, bold=True, color="FFFFFF")
TITLE = Font(name=FONT, size=14, bold=True)
H2 = Font(name=FONT, size=11, bold=True)
GREY_TEXT = Font(name=FONT, size=9, color="808080")
HEAD_FILL = PatternFill("solid", fgColor="3B4A5A")
INPUT_FILL = PatternFill("solid", fgColor="FFF2A8")
GIVEN_FILL = PatternFill("solid", fgColor="F2F2F2")
WRAP_TOP = Alignment(wrap_text=True, vertical="top")
TOP = Alignment(vertical="top")
THIN = Side(style="thin", color="D0D0D0")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def build(src, out) -> int:
    books = json.load(open(src, encoding="utf-8"))["books"]
    n = len(books)
    wb = Workbook()

    # --- How to label ---------------------------------------------------------
    how = wb.active
    how.title = "How to label"
    how.column_dimensions["A"].width = 26
    how.column_dimensions["B"].width = 100
    rows = [
        ("Bookie: book trait labels (BE-15)", None, TITLE),
        (None, None, None),
        ("Progress", f'=COUNTIF(Labels!O2:O{n + 1},"done")&" of {n} books labelled"', BOLD),
        (None, None, None),
        ("What you do", None, H2),
        ("1.", "Go to the Labels sheet. Each row is one book. Fill in the yellow cells only, using the dropdowns.", None),
        ("2.", "Read the book's description (column D) and its reviews on the Reviews sheet: filter the Book # column to the book's number. Read at least the first 10 reviews; they alternate between readers who liked and disliked the book. Skim more when it is unclear.", None),
        ("3.", "Pick pace, tone and content intensity. Pick \"unknown\" when the text does not clearly show it.", None),
        ("4.", "Pick up to 5 themes, most important first. Leave the other theme cells empty. Only pick a theme the book is substantially about.", None),
        ("5.", "Label from the description and reviews only, not from what you know about the book elsewhere: the models are judged on the same text.", None),
        ("6.", "The file contains no AI answers, on purpose. Label without looking any up.", None),
        ("7.", "A row counts as done when pace, tone and content intensity are filled (column O). You can stop and continue any time; save as you go.", None),
        ("8.", "When finished, save the file and give it back. It contains readers' review text from the dataset: keep it private, do not upload or share it.", None),
        (None, None, None),
        ("Definitions", None, H2),
        ("pace", "How quickly the story moves, as readers experience it. slow: slow, meandering, a slow burn, dragging. moderate: steady; neither stands out. fast: fast-paced, a page-turner, hard to put down, action-packed.", None),
        ("tone", "The single most fitting overall tone, for the book as a whole. dark: grim, bleak. light: easy, breezy, fun. serious: weighty and earnest, not mainly dark or sad. humorous: mainly funny or witty. hopeful: uplifting, heartwarming. melancholic: sad, wistful, bittersweet. tense: suspenseful, thrilling. romantic: centred on a love story.", None),
        ("content intensity", "How graphic or disturbing the content is (violence, sex, abuse, gore). low: little or none, or mild and off the page. moderate: present and noticeable, not dwelt on in graphic detail. high: graphic, explicit or repeatedly disturbing; readers warn about it.", None),
        ("themes", "Up to 5 of: " + ", ".join(THEMES) + ".", None),
        ("disagreeing reviews", "Follow what most reviews say, and the description for what the book is about. Judge the book, not the reviewer's opinion: \"I hated how slow it was\" means slow pace.", None),
        (None, None, None),
        ("Legend", None, H2),
        ("Yellow cell", "Fill in (dropdown).", None),
        ("Grey cell", "Given; do not edit.", None),
        (None, None, None),
        ("Example (not a book in the set)", None, H2),
        ("Description", "A sixteen-year-old enters a televised fight to the death in her sister's place.", None),
        ("Reviews say", "\"Couldn't put it down\", \"brutal but not gory\", \"the love triangle annoyed me\", \"about survival and an unjust government\".", None),
        ("Labels", "pace: fast · tone: tense · content intensity: moderate · themes: survival, power and politics, social class and inequality, love and romance", None),
    ]
    for r, (a, b, font) in enumerate(rows, start=1):
        if a is not None:
            how.cell(row=r, column=1, value=a).font = font or BOLD
        if b is not None:
            c = how.cell(row=r, column=2, value=b)
            c.font = font if font is BOLD else BASE
            c.alignment = WRAP_TOP
        how.cell(row=r, column=1).alignment = TOP
    how["A24"].fill = INPUT_FILL
    how["A25"].fill = GIVEN_FILL

    # --- Lists (hidden) -------------------------------------------------------
    lists = wb.create_sheet("Lists")
    for col, values in enumerate([PACE, TONE, INTENSITY, THEMES], start=1):
        for r, v in enumerate(values, start=1):
            lists.cell(row=r, column=col, value=v).font = BASE
    lists.sheet_state = "hidden"

    # --- Labels ---------------------------------------------------------------
    lab = wb.create_sheet("Labels")
    heads = [
        ("Book #", 7), ("Title", 28), ("Author", 18), ("Description", 60), ("Reviews", 8),
        ("Pace", 12), ("Tone", 13), ("Content intensity", 13),
        ("Theme 1", 20), ("Theme 2", 20), ("Theme 3", 20), ("Theme 4", 20), ("Theme 5", 20),
        ("Notes (optional)", 24), ("Done", 7), ("Edition ID (do not edit)", 38),
    ]
    for c, (h, w) in enumerate(heads, start=1):
        cell = lab.cell(row=1, column=c, value=h)
        cell.font, cell.fill, cell.alignment, cell.border = HEAD, HEAD_FILL, WRAP_TOP, BOX
        lab.column_dimensions[get_column_letter(c)].width = w
    lab.row_dimensions[1].height = 30
    lab["E1"].comment = Comment("How many reviews this book has on the Reviews sheet (the same ones the models read).", "Bookie")

    def dv(ref: str, prompt: str) -> DataValidation:
        v = DataValidation(type="list", formula1=ref, allow_blank=True, showErrorMessage=True)
        v.error, v.errorTitle, v.prompt = "Pick a value from the list.", "Not in the list", prompt
        v.showInputMessage = True
        lab.add_data_validation(v)
        return v

    v_pace = dv(f"=Lists!$A$1:$A${len(PACE)}", "slow, moderate, fast or unknown")
    v_tone = dv(f"=Lists!$B$1:$B${len(TONE)}", "One overall tone, or unknown")
    v_int = dv(f"=Lists!$C$1:$C${len(INTENSITY)}", "low, moderate, high or unknown")
    v_theme = dv(f"=Lists!$D$1:$D${len(THEMES)}", "Up to 5 themes, most important first")

    for i, b in enumerate(books):
        r = i + 2
        authors = ", ".join(b["authors"]) if b["authors"] else ""
        given = [b["number"], b["title"], authors, b["description"] or "(no description)", len(b["reviews"])]
        for c, v in enumerate(given, start=1):
            cell = lab.cell(row=r, column=c, value=clean(v))
            cell.font, cell.fill, cell.border = BASE, GIVEN_FILL, BOX
            cell.alignment = WRAP_TOP if c in (2, 3, 4) else TOP
        for c in range(6, 15):
            cell = lab.cell(row=r, column=c)
            cell.font, cell.border, cell.alignment = BASE, BOX, TOP
            if c <= 13:
                cell.fill = INPUT_FILL
        done = lab.cell(row=r, column=15, value=f'=IF(AND(F{r}<>"",G{r}<>"",H{r}<>""),"done","")')
        done.font, done.border, done.alignment = BOLD, BOX, TOP
        eid = lab.cell(row=r, column=16, value=b["editionId"])
        eid.font, eid.fill, eid.border = GREY_TEXT, GIVEN_FILL, BOX
        lab.row_dimensions[r].height = 90
    last = n + 1
    v_pace.add(f"F2:F{last}")
    v_tone.add(f"G2:G{last}")
    v_int.add(f"H2:H{last}")
    v_theme.add(f"I2:M{last}")
    lab.freeze_panes = "C2"

    # --- Reviews --------------------------------------------------------------
    rev = wb.create_sheet("Reviews")
    for c, (h, w) in enumerate([("Book #", 8), ("Title", 26), ("Review #", 9), ("Rating", 8), ("Review text", 120)], start=1):
        cell = rev.cell(row=1, column=c, value=h)
        cell.font, cell.fill, cell.alignment = HEAD, HEAD_FILL, WRAP_TOP
        rev.column_dimensions[get_column_letter(c)].width = w
    rev["D1"].comment = Comment("The reader's star rating, 1 to 5; empty when they gave none.", "Bookie")
    r = 2
    for b in books:
        for x in b["reviews"]:
            vals = [b["number"], b["title"], x["number"], x["rating"], x["text"]]
            for c, v in enumerate(vals, start=1):
                cell = rev.cell(row=r, column=c, value=clean(v))
                cell.font = BASE
                cell.alignment = WRAP_TOP if c == 5 else TOP
            r += 1
    rev.auto_filter.ref = f"A1:E{r - 1}"
    rev.freeze_panes = "A2"

    wb._sheets = [how, lab, rev, lists]
    wb.active = 0
    wb.calculation.fullCalcOnLoad = True
    wb.save(out)
    return n

