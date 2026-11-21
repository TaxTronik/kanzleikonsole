// Die Fehlerstelle ist die Feldvorgabe. Zeitstempel, gespeicherte DATE-Felder und
// eine bereits nach Berlin umgerechnete Uhr bleiben gültige Datenquellen.
const inputTypes = new Set(['date', 'datetime-local', 'month', 'week', 'number']);
const fieldProps = new Set(['value', 'defaultValue', 'min', 'max']);

function isCalendarProp({ name, parent }) {
  const prop = name.name;
  const tag = parent.name.name;
  if (tag === 'input') {
    const type = parent.attributes.find((attr) => attr.name?.name === 'type')?.value;
    return fieldProps.has(prop) && inputTypes.has(type?.value ?? type?.expression?.value);
  }
  if (tag === 'select') return prop === 'value' || prop === 'defaultValue';
  return (
    /^(?:default|initial|suggested|min|max).*?(?:Date|Day|Year|From|Until|Ymd|Month|Week|At)$/.test(
      prop,
    ) ||
    (/(?:Date|Calendar|Year)/.test(tag) && fieldProps.has(prop))
  );
}

function receiver(node, method) {
  const callee = node?.type === 'CallExpression' ? node.callee : null;
  return callee?.type === 'MemberExpression' && !callee.computed && callee.property.name === method
    ? callee.object
    : null;
}

function create(context) {
  function binding(id) {
    for (let scope = context.sourceCode.getScope(id); scope; scope = scope.upper) {
      if (scope.set.has(id.name)) return scope.set.get(id.name);
    }
  }

  function initializer(id) {
    const variable = binding(id);
    const declaration = variable?.defs[0]?.node;
    if (declaration?.type !== 'VariableDeclarator') return null;
    if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
    if (declaration.id.type === 'Identifier') return declaration.init;
    // Bei kontrollierten Feldern kann [wert, setzen] = useState(...) die Vorgabe liefern.
    const init = declaration.init;
    if (
      declaration.id.type === 'ArrayPattern' &&
      declaration.id.elements[0]?.name === id.name &&
      init?.type === 'CallExpression' &&
      (init.callee.name === 'useState' || receiver(init, 'useState'))
    ) {
      const first = init.arguments[0];
      return first?.type === 'ArrowFunctionExpression' ? first.body : first;
    }
    return null;
  }

  // Nur bekannte lokale Werte verfolgen. Unbekannte Funktionen können die
  // Zeitzone umrechnen. Bei Bedingungsausdrücken zählen ausschließlich die Ergebniszweige.
  function originates(node, matches, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'Identifier') return originates(initializer(node), matches, seen);
    if (
      [
        'ChainExpression',
        'TSAsExpression',
        'TSNonNullExpression',
        'TSSatisfiesExpression',
      ].includes(node.type)
    ) {
      return originates(node.expression, matches, seen);
    }
    if (
      node.type === 'LogicalExpression' ||
      (node.type === 'BinaryExpression' && ['+', '-'].includes(node.operator))
    ) {
      return originates(node.left, matches, seen) || originates(node.right, matches, seen);
    }
    if (node.type === 'ConditionalExpression') {
      return (
        originates(node.consequent, matches, seen) || originates(node.alternate, matches, seen)
      );
    }
    return matches(node, seen);
  }

  function globalDate(node) {
    return node?.type === 'Identifier' && node.name === 'Date' && !binding(node)?.defs.length;
  }

  function systemClock(node, seen) {
    if (node.type === 'NewExpression' && globalDate(node.callee)) {
      return (
        node.arguments.length === 0 ||
        (node.arguments.length === 1 && originates(node.arguments[0], systemClock, seen))
      );
    }
    return (
      globalDate(receiver(node, 'now')) || originates(receiver(node, 'getTime'), systemClock, seen)
    );
  }

  function clockIso(node) {
    return originates(receiver(node, 'toISOString'), systemClock);
  }

  function utcCalendarValue(node) {
    if (originates(receiver(node, 'getUTCFullYear'), systemClock)) return true;
    const text = receiver(node, 'slice') ?? receiver(node, 'substring');
    if (text && node.arguments[0]?.value === 0 && [4, 7, 10].includes(node.arguments[1]?.value)) {
      return originates(text, clockIso);
    }
    if (node.type === 'MemberExpression' && node.computed && node.property.value === 0) {
      const iso = receiver(node.object, 'split');
      return iso && node.object.arguments[0]?.value === 'T' && originates(iso, clockIso);
    }
    return false;
  }

  return {
    JSXAttribute(node) {
      if (isCalendarProp(node) && originates(node.value?.expression, utcCalendarValue)) {
        context.report({ node, messageId: 'utcToday' });
      }
    },
  };
}

export const berlinCalendarPlugin = {
  rules: {
    'no-utc-today-in-form': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          utcToday:
            'Diese Kalendervorgabe leitet Tag oder Jahr der aktuellen Uhr aus UTC ab. Verwende den Berliner Kalendertag (berlinYmd, berlinYmdAfterDays oder berlinTodayUtcMidnight).',
        },
      },
      create,
    },
  },
};
