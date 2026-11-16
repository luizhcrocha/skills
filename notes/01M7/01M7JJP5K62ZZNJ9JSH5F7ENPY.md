+++
id = "01M7JJP5K62ZZNJ9JSH5F7ENPY"
kind = "decision"
scope = "project:luizhcrocha/skills"
by = "eca9b74c-7dff-43f4-9e80-4f6d48159c0f/interactive"
at = "2026-11-16T16:22:48Z"
+++
peek converts docx/odt/pptx to PDF via headless LibreOffice (keeps clause numbering pandoc drops) and xlsx/xls/ods to HTML tables; docx falls back to pandoc HTML. LibreOffice is unsandboxed: linked files can enter the PDF.
