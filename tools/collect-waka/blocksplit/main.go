// blocksplit splits a Japanese tanka (5-7-5-7-7) into 5 blocks and emits
// surface + hiragana yomi per block. Logic mirrors github.com/mattn/go-haiku
// MatchWithOpt so it agrees with the haikubot's matching decision.
//
// Input  (stdin, JSONL): {"text": "...", "note1": "..."}
// Output (stdout, TSV) : 1 \t s0 \t s1 \t s2 \t s3 \t s4 \t y0 \t y1 \t y2 \t y3 \t y4 \t note1
// Lines that don't match 5-7-5-7-7 are dropped (and reported on stderr).

package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	ipaneologd "github.com/ikawaha/kagome-dict-ipa-neologd"
	"github.com/ikawaha/kagome-dict/dict"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

var (
	reWord       = regexp.MustCompile(`^[ァ-ヾ]+$`)
	reIgnoreText = regexp.MustCompile(`[\[\]「」『』、。？！]`)
	reIgnoreChar = regexp.MustCompile(`[ァィゥェォャュョ]`)
	reKana       = regexp.MustCompile(`^[ァ-タダ-ヶ]+$`)
)

func dictIdx(d *dict.Dict, typ string) int {
	if ii, ok := d.ContentsMeta[typ]; ok {
		return int(ii)
	}
	return -1
}

func contains(c []string, s string) bool {
	for _, cc := range c {
		if cc == s {
			return true
		}
	}
	return false
}

func isEnd(d *dict.Dict, c []string) bool {
	if len(c) < 2 {
		return true
	}
	idx := dictIdx(d, dict.PronunciationIndex)
	if c[0] == "接頭辞" {
		if idx >= 0 && contains(c, "御") {
			return false
		}
		return true
	}
	if c[1] == "非自立" {
		if c[0] == "名詞" {
			return true
		}
		if c[0] == "動詞" {
			return true
		}
		if idx >= 0 && c[idx] == "ノ" {
			return true
		}
		return false
	}
	idx = dictIdx(d, dict.InflectionalForm)
	if idx >= 0 && idx < len(c) {
		if c[idx] == "未然形" {
			return false
		}
	}
	return true
}

func isIgnore(_ *dict.Dict, c []string) bool {
	return len(c) > 1 && (c[0] == "空白" || c[0] == "補助記号" || (c[0] == "記号" && c[1] == "空白"))
}

func isWord(_ *dict.Dict, c []string) bool {
	if len(c) < 2 {
		return false
	}
	if c[0] != "名詞" && c[1] == "非自立" {
		return false
	}
	for _, f := range []string{"名詞", "形容詞", "形容動詞", "副詞", "連体詞", "接続詞", "感動詞", "接頭詞", "フィラー"} {
		if f == c[0] && c[1] != "接尾" {
			return true
		}
	}
	if c[0] == "接頭辞" || (c[0] == "接続詞" && c[1] == "名詞接続") {
		return false
	}
	if c[0] == "形状詞" && c[1] != "助動詞語幹" {
		return true
	}
	if c[0] == "代名詞" {
		return true
	}
	if c[0] == "記号" && c[1] == "一般" {
		return true
	}
	if c[0] == "助詞" && c[1] != "副助詞" && c[1] != "準体助詞" && c[1] != "終助詞" && c[1] != "係助詞" && c[1] != "格助詞" && c[1] != "接続助詞" && c[1] != "連体化" && c[1] != "副助詞／並立助詞／終助詞" {
		return true
	}
	if c[0] == "動詞" && c[1] != "接尾" && c[1] != "非自立" {
		return true
	}
	if c[0] == "カスタム人名" || c[0] == "カスタム名詞" {
		return true
	}
	return false
}

func countChars(s string) int {
	return len([]rune(reIgnoreChar.ReplaceAllString(s, "")))
}

func katToHira(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if r >= 'ァ' && r <= 'ヶ' {
			sb.WriteRune(r - 0x60)
		} else {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// splitTanka mirrors the loop body of MatchWithOpt, but accumulates the
// surface and yomi for each of the 5 blocks instead of returning a bool.
func splitTanka(text string, t *tokenizer.Tokenizer, d *dict.Dict) (surfaces, yomis []string, ok bool) {
	rule := []int{5, 7, 5, 7, 7}
	text = reIgnoreText.ReplaceAllString(text, " ")
	tokens := t.Tokenize(text)

	var filtered []tokenizer.Token
	for _, tok := range tokens {
		if !isIgnore(d, tok.Features()) {
			filtered = append(filtered, tok)
		}
	}
	tokens = filtered

	sBuf := make([]strings.Builder, len(rule))
	yBuf := make([]strings.Builder, len(rule))
	pos := 0
	r := make([]int, len(rule))
	copy(r, rule)

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]
		c := tok.Features()
		var y string
		if reKana.MatchString(tok.Surface) {
			y = tok.Surface
		} else if len(c) == 3 {
			y = c[2]
		} else {
			idx := dictIdx(d, dict.PronunciationIndex)
			if idx >= 0 && idx < len(c) {
				y = c[idx]
			} else {
				y = tok.Surface
			}
		}
		if !reWord.MatchString(y) {
			if y == "、" {
				continue
			}
			return nil, nil, false
		}
		if pos >= len(rule) || (r[pos] == rule[pos] && !isWord(d, c)) {
			return nil, nil, false
		}
		n := countChars(y)
		r[pos] -= n
		sBuf[pos].WriteString(tok.Surface)
		yBuf[pos].WriteString(y)
		if r[pos] == 0 {
			if !isEnd(d, c) {
				return nil, nil, false
			}
			pos++
			if pos == len(r) && i == len(tokens)-1 {
				surfaces = make([]string, len(rule))
				yomis = make([]string, len(rule))
				for k := range rule {
					surfaces[k] = sBuf[k].String()
					yomis[k] = katToHira(yBuf[k].String())
				}
				return surfaces, yomis, true
			}
		}
	}
	return nil, nil, false
}

type input struct {
	Text  string `json:"text"`
	Note1 string `json:"note1"`
}

func main() {
	var userdicPath string
	flag.StringVar(&userdicPath, "userdic", "", "path to userdic.txt (kagome user dictionary)")
	flag.Parse()

	d := ipaneologd.Dict()

	opts := []tokenizer.Option{tokenizer.OmitBosEos()}
	if userdicPath != "" {
		f, err := os.Open(userdicPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "[error] open userdic:", err)
			os.Exit(1)
		}
		records, err := dict.NewUserDicRecords(f)
		f.Close()
		if err != nil {
			fmt.Fprintln(os.Stderr, "[error] read userdic:", err)
			os.Exit(1)
		}
		userDic, err := records.NewUserDict()
		if err != nil {
			fmt.Fprintln(os.Stderr, "[error] build userdic:", err)
			os.Exit(1)
		}
		opts = append(opts, tokenizer.UserDict(userDic))
	}
	t, err := tokenizer.New(d, opts...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[error] tokenizer:", err)
		os.Exit(1)
	}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	matched, dropped := 0, 0
	for in.Scan() {
		line := in.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var rec input
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			fmt.Fprintln(os.Stderr, "[warn] bad json:", err)
			continue
		}
		surfaces, yomis, ok := splitTanka(rec.Text, t, d)
		if !ok {
			dropped++
			fmt.Fprintf(os.Stderr, "[drop] %s | %s\n", rec.Note1, strings.ReplaceAll(rec.Text, "\n", " / "))
			continue
		}
		fmt.Fprintf(out, "1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			surfaces[0], surfaces[1], surfaces[2], surfaces[3], surfaces[4],
			yomis[0], yomis[1], yomis[2], yomis[3], yomis[4],
			rec.Note1)
		matched++
	}
	if err := in.Err(); err != nil && err != io.EOF {
		fmt.Fprintln(os.Stderr, "[error] read stdin:", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "[done] matched=%d dropped=%d\n", matched, dropped)
}
