+++
id = "01M7DJ5WZEWF59AY5JXFFN1RXX"
kind = "gotcha"
scope = "project:luizhcrocha/skills"
by = "8c9c0fa8-9eab-44f6-bd1a-f35ec235a3fc/interactive"
at = "2026-11-14T17:37:43Z"
+++
casos Bazel: before handing a BUILD change to runner, load every package locally (tools/bazel/bz query 'tests(//...)' in the workspace, direnv allowed). 11-14 a duplicated data label failed loading on the testbox, the gate fell back and the test tier took 706 s instead of 359.
