/**
 * @file dbt models and macros: Jinja over SQL
 * @license MIT
 *
 * A dbt file is a Jinja template whose text is SQL. This grammar parses the
 * Jinja in full — every tag, block and expression dbt uses — and leaves the
 * text between the tags as `content` nodes, which `queries/injections.scm`
 * hands to a SQL grammar as one combined document. It does not parse SQL.
 *
 * Expression precedence follows Jinja's parser (jinja2/parser.py), loosest
 * first: conditional, or, and, not, comparison, + -, ~, * / // %, **, unary,
 * then filters and tests, then attribute, subscript and call.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  conditional: 1,
  or: 2,
  and: 3,
  not: 4,
  compare: 5,
  add: 6,
  concat: 7,
  multiply: 8,
  power: 9,
  unary: 10,
  filter: 11,
  postfix: 12,
};

const commaSep1 = (rule) => seq(rule, repeat(seq(',', rule)));
const commaSep = (rule) => optional(commaSep1(rule));
const trailingCommaSep = (rule) => optional(seq(commaSep1(rule), optional(',')));

export default grammar({
  name: 'dbt',

  externals: ($) => [$.content, $.raw_content],

  extras: (_) => [/\s/],

  word: ($) => $.identifier,

  conflicts: ($) => [
    // {% call (row) macro(row) %}: parameters, not an expression
    [$.parameters, $.tuple],
    [$.parameters, $._primary_expression],
    // {% set (a, b) = x %}: a target, not the object of an attribute
    [$._target_item, $._primary_expression],
    [$.target_tuple, $.tuple],
    // the body of an elif or else ends where a `{%` opens elif, else or the end
    [$.elif_clause],
    [$.else_clause],
  ],

  supertypes: ($) => [$._expression, $._statement],

  rules: {
    source_file: ($) => repeat($._node),

    _node: ($) => choice($.content, $.comment, $.output, $._statement),

    // ── delimiters ───────────────────────────────────────────────────────
    // `-` and `+` are Jinja's whitespace control; they are part of the token.
    _tag_open: (_) => choice('{%', '{%-', '{%+'),
    _tag_close: (_) => choice('%}', '-%}', '+%}'),

    comment: (_) =>
      token(seq('{#', /[^#]*#+([^#}][^#]*#+)*/, '}')),

    output: ($) =>
      seq(choice('{{', '{{-', '{{+'), $._expression, choice('}}', '-}}', '+}}')),

    // ── statements ───────────────────────────────────────────────────────
    _statement: ($) =>
      choice(
        $.if_statement,
        $.for_statement,
        $.macro_definition,
        $.call_block,
        $.filter_block,
        $.set_statement,
        $.set_block,
        $.raw_block,
        $.with_block,
        $.do_statement,
        $.include_statement,
        $.import_statement,
        $.from_import_statement,
        $.break_statement,
        $.continue_statement,
        $.materialization_definition,
        $.test_definition,
        $.snapshot_block,
        $.docs_block,
      ),

    if_statement: ($) =>
      seq(
        $._tag_open, 'if', field('condition', $._expression), optional(':'), $._tag_close,
        repeat(field('consequence', $._node)),
        repeat(field('alternative', $.elif_clause)),
        optional(field('alternative', $.else_clause)),
        $._tag_open, 'endif', $._tag_close,
      ),

    elif_clause: ($) =>
      seq(
        $._tag_open, 'elif', field('condition', $._expression), optional(':'), $._tag_close,
        repeat(field('consequence', $._node)),
      ),

    else_clause: ($) =>
      seq($._tag_open, 'else', optional(':'), $._tag_close, repeat(field('body', $._node))),

    for_statement: ($) =>
      seq(
        $._tag_open, 'for',
        field('left', $._target),
        'in',
        // Jinja parses the iterable without a conditional, as a trailing
        // `if` filters the loop.
        field('right', choice($._simple_expression, alias($._bare_tuple, $.tuple))),
        optional(seq('if', field('filter', $._simple_expression))),
        optional('recursive'),
        optional(':'),
        $._tag_close,
        repeat(field('body', $._node)),
        optional(field('alternative', $.else_clause)),
        $._tag_open, 'endfor', $._tag_close,
      ),

    macro_definition: ($) =>
      seq(
        $._tag_open, 'macro', field('name', $.identifier),
        field('parameters', $.parameters), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endmacro', optional($.identifier), $._tag_close,
      ),

    call_block: ($) =>
      seq(
        $._tag_open, 'call',
        optional(field('parameters', $.parameters)),
        field('call', $.call), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endcall', $._tag_close,
      ),

    filter_block: ($) =>
      seq(
        $._tag_open, 'filter', field('filter', $.filter_chain), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endfilter', $._tag_close,
      ),

    filter_chain: ($) => seq($._filter_item, repeat(seq('|', $._filter_item))),

    set_statement: ($) =>
      seq(
        $._tag_open, 'set',
        field('left', choice($._target, $.attribute)),
        '=',
        field('right', choice($._expression, alias($._bare_tuple, $.tuple))),
        $._tag_close,
      ),

    set_block: ($) =>
      seq(
        $._tag_open, 'set', field('left', $._set_target),
        optional(seq('|', field('filter', $.filter_chain))),
        $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endset', $._tag_close,
      ),

    _set_target: ($) => choice($.identifier, $.attribute),

    raw_block: ($) =>
      seq(
        $._tag_open, 'raw', $._tag_close,
        optional($.raw_content),
        $._tag_open, 'endraw', $._tag_close,
      ),

    with_block: ($) =>
      seq(
        $._tag_open, 'with', commaSep($.assignment), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endwith', $._tag_close,
      ),

    assignment: ($) =>
      seq(field('left', $.identifier), '=', field('right', $._expression)),

    do_statement: ($) => seq($._tag_open, 'do', $._expression, $._tag_close),

    include_statement: ($) =>
      seq(
        $._tag_open, 'include', field('template', $._expression),
        optional(seq('ignore', 'missing')),
        optional($._context_modifier),
        $._tag_close,
      ),

    import_statement: ($) =>
      seq(
        $._tag_open, 'import', field('template', $._expression),
        'as', field('alias', $.identifier),
        optional($._context_modifier),
        $._tag_close,
      ),

    from_import_statement: ($) =>
      seq(
        $._tag_open, 'from', field('template', $._expression), 'import',
        commaSep1($.import_name), optional(','),
        optional($._context_modifier),
        $._tag_close,
      ),

    import_name: ($) =>
      seq(field('name', $.identifier), optional(seq('as', field('alias', $.identifier)))),

    _context_modifier: (_) => seq(choice('with', 'without'), 'context'),

    break_statement: ($) => seq($._tag_open, 'break', $._tag_close),
    continue_statement: ($) => seq($._tag_open, 'continue', $._tag_close),

    // ── dbt's own blocks ─────────────────────────────────────────────────
    // {% materialization table, adapter='snowflake', supported_languages=['sql'] %}
    materialization_definition: ($) =>
      seq(
        $._tag_open, 'materialization', field('name', $.identifier),
        repeat(seq(',', choice($.keyword_argument, $.identifier))),
        $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endmaterialization', $._tag_close,
      ),

    // {% test not_null(model, column_name) %}
    test_definition: ($) =>
      seq(
        $._tag_open, 'test', field('name', $.identifier),
        field('parameters', $.parameters), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endtest', $._tag_close,
      ),

    snapshot_block: ($) =>
      seq(
        $._tag_open, 'snapshot', field('name', $.identifier), $._tag_close,
        repeat(field('body', $._node)),
        $._tag_open, 'endsnapshot', $._tag_close,
      ),

    // A docs block's text is Markdown, not SQL, so it is its own node.
    docs_block: ($) =>
      seq(
        $._tag_open, 'docs', field('name', $.identifier), $._tag_close,
        repeat(field('body', $._docs_node)),
        $._tag_open, 'enddocs', $._tag_close,
      ),

    _docs_node: ($) =>
      choice(alias($.content, $.markdown_content), $.comment, $.output),

    // ── parameters and targets ───────────────────────────────────────────
    parameters: ($) =>
      seq('(', trailingCommaSep(choice($.identifier, $.default_parameter)), ')'),

    default_parameter: ($) =>
      seq(field('name', $.identifier), '=', field('value', $._expression)),

    _target: ($) =>
      choice($.identifier, alias($._bare_target_tuple, $.tuple), $.target_tuple),

    _bare_target_tuple: ($) =>
      seq($._target_item, repeat1(seq(',', $._target_item)), optional(',')),

    target_tuple: ($) => seq('(', trailingCommaSep($._target_item), ')'),

    _target_item: ($) => choice($.identifier, $.target_tuple),

    _bare_tuple: ($) =>
      prec.right(seq($._expression, repeat1(seq(',', $._expression)), optional(','))),

    // ── expressions ──────────────────────────────────────────────────────
    _expression: ($) => choice($.conditional_expression, $._simple_expression),

    _simple_expression: ($) =>
      choice(
        $.boolean_operator,
        $.not_operator,
        $.comparison_operator,
        $.binary_operator,
        $.unary_operator,
        $.filter_expression,
        $.test_expression,
        $._primary_expression,
      ),

    conditional_expression: ($) =>
      prec.right(PREC.conditional, seq(
        field('consequence', $._simple_expression),
        'if', field('condition', $._simple_expression),
        optional(seq('else', field('alternative', $._expression))),
      )),

    boolean_operator: ($) =>
      choice(
        prec.left(PREC.or, seq(field('left', $._simple_expression), field('operator', 'or'), field('right', $._simple_expression))),
        prec.left(PREC.and, seq(field('left', $._simple_expression), field('operator', 'and'), field('right', $._simple_expression))),
      ),

    not_operator: ($) =>
      prec(PREC.not, seq('not', field('argument', $._simple_expression))),

    comparison_operator: ($) =>
      prec.left(PREC.compare, seq(
        field('left', $._simple_expression),
        field('operator', choice('==', '!=', '<', '<=', '>', '>=', 'in', alias(seq('not', 'in'), 'not in'))),
        field('right', $._simple_expression),
      )),

    binary_operator: ($) => {
      const table = [
        [prec.left, PREC.add, choice('+', '-')],
        [prec.left, PREC.concat, '~'],
        [prec.left, PREC.multiply, choice('*', '/', '//', '%')],
        [prec.left, PREC.power, '**'],
      ];
      return choice(...table.map(([fn, p, op]) =>
        // @ts-ignore
        fn(p, seq(field('left', $._simple_expression), field('operator', op), field('right', $._simple_expression)))));
    },

    unary_operator: ($) =>
      prec(PREC.unary, seq(field('operator', choice('-', '+')), field('argument', $._simple_expression))),

    // x | default('a') | upper
    filter_expression: ($) =>
      prec.left(PREC.filter, seq(field('value', $._simple_expression), '|', $._filter_item)),

    _filter_item: ($) =>
      choice(
        field('filter', $._dotted_name),
        seq(field('filter', $._dotted_name), field('arguments', $.argument_list)),
      ),

    // x is defined, x is not none, x is divisibleby 3, x is sameas(false)
    test_expression: ($) =>
      prec.left(PREC.filter, seq(
        field('value', $._simple_expression),
        'is', optional('not'),
        field('test', $._dotted_name),
        optional(field('argument', choice(
          $.argument_list, $.string, $.integer, $.float, $.boolean, $.none,
        ))),
      )),

    _dotted_name: ($) =>
      choice($.identifier, alias($._dotted_identifier, $.dotted_name)),

    _dotted_identifier: ($) => seq($.identifier, repeat1(seq('.', $.identifier))),

    _primary_expression: ($) =>
      choice(
        $.identifier,
        $.string,
        $.concatenated_string,
        $.integer,
        $.float,
        $.boolean,
        $.none,
        $.list,
        $.dict,
        $.tuple,
        $.parenthesized_expression,
        $.attribute,
        $.subscript,
        $.call,
      ),

    attribute: ($) =>
      prec(PREC.postfix, seq(field('object', $._primary_expression), '.', field('attribute', $.identifier))),

    subscript: ($) =>
      prec(PREC.postfix, seq(
        field('value', $._primary_expression),
        '[', field('subscript', choice($._expression, alias($._bare_tuple, $.tuple), $.slice)), ']',
      )),

    slice: ($) =>
      seq(optional($._expression), ':', optional($._expression), optional(seq(':', optional($._expression)))),

    call: ($) =>
      prec(PREC.postfix, seq(field('function', $._primary_expression), field('arguments', $.argument_list))),

    argument_list: ($) =>
      seq('(', trailingCommaSep(choice(
        $._expression,
        $.keyword_argument,
        $.list_splat,
        $.dictionary_splat,
      )), ')'),

    keyword_argument: ($) =>
      seq(field('name', $.identifier), '=', field('value', $._expression)),

    list_splat: ($) => seq('*', $._expression),
    dictionary_splat: ($) => seq('**', $._expression),

    parenthesized_expression: ($) => seq('(', $._expression, ')'),

    tuple: ($) =>
      choice(
        seq('(', ')'),
        seq('(', $._expression, ',', ')'),
        seq('(', $._expression, repeat1(seq(',', $._expression)), optional(','), ')'),
      ),

    list: ($) => seq('[', trailingCommaSep($._expression), ']'),

    dict: ($) => seq('{', trailingCommaSep($.pair), '}'),

    pair: ($) => seq(field('key', $._expression), ':', field('value', $._expression)),

    // ── literals ─────────────────────────────────────────────────────────
    string: ($) =>
      choice(
        seq('"', repeat(choice(alias(token.immediate(prec(1, /[^"\\]+/)), $.string_content), $.escape_sequence)), '"'),
        seq("'", repeat(choice(alias(token.immediate(prec(1, /[^'\\]+/)), $.string_content), $.escape_sequence)), "'"),
      ),

    // Jinja joins adjacent strings: "a" "b" is "ab".
    concatenated_string: ($) => seq($.string, repeat1($.string)),

    escape_sequence: (_) => token.immediate(/\\(.|\n)/),

    integer: (_) => token(choice(/[0-9][0-9_]*/, /0[xX][0-9a-fA-F_]+/, /0[oO][0-7_]+/, /0[bB][01_]+/)),

    float: (_) =>
      token(choice(
        /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9_]+)?/,
        /[0-9][0-9_]*[eE][+-]?[0-9_]+/,
      )),

    boolean: (_) => choice('true', 'false', 'True', 'False'),
    none: (_) => choice('none', 'None'),

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,
  },
});
