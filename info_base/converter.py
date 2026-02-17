import json
import pathlib
import fitz  # pip install pymupdf

PDF_PATH = pathlib.Path.home() / "Downloads" / "RentersHandbook_English.pdf"

doc = fitz.open(str(PDF_PATH))  # also safer to pass str here

data = {
    "source_file": str(PDF_PATH),  # <-- FIXED
    "pages": [
        {"page": i + 1, "text": doc[i].get_text("text")}
        for i in range(len(doc))
    ]
}

out_path = pathlib.Path("seattle_renters_handbook_pages.json")
out_path.write_text(
    json.dumps(data, ensure_ascii=False, indent=2),
    encoding="utf-8"
)

print(f"Wrote: {out_path.resolve()}")
