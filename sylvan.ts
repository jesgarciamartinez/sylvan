/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region UTILS

// @ts-expect-error
let __DEV__ = process.env.NODE_ENV == 'development'

//#region asserts
function assert(condition: boolean | (() => boolean), message?: string): asserts condition {
  if (__DEV__) {
    //if condition is an object access like el.isConnected, must be wrapped in fn or it won't get cleaned up in prod
    if (typeof condition == 'function') condition = condition()
    if (condition === false) {
      throw new Error(message || 'Assertion failed')
    }
  }
}
function assert_exists<T>(v: T): asserts v is NonNullable<T> {
  if (__DEV__) {
    if (!exists(v)) {
      throw new Error(`Assertion failed: expected ${v} to be defined.`)
    }
  }
}

function assert_is_node(v: any): asserts v is Node {
  if (__DEV__) {
    if (!(v instanceof Node)) {
      throw new Error(`Assertion failed: expected ${v} to be instanceof Node.`)
    }
  }
}

function assert_is<T>(_v: any): asserts _v is T {}

let TODO = (s?: string) => {
  if (__DEV__) throw new Error(`TODO ${s ?? ''}`)
}
// let TODO = console.error.bind(console, 'TODO')

//#endregion

let is_array = Array.isArray,
  is_arr_or_obj = (v: unknown) => v != null && typeof v === 'object',
  /** typeof v == 'function' */
  is_fn = (v: unknown): v is Function => typeof v == 'function',
  /** typeof v == 'string' */
  is_str = (v: unknown): v is string => typeof v == 'string',
  is_node = (v: any): v is Node => v instanceof Node,
  /** is not null or undefined */
  exists = <T>(v: T | undefined | null): v is T => v != null,
  /** is null or undefined */
  empty = (v: Set<any> | Map<any, any> | Array<any> | string) =>
    ((v as Set<any>).size ?? (v as any[]).length) == 0

type El = HTMLElement | SVGElement
type AnyObject = Record<string | number | symbol, unknown>
//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region TYPES

/**
 * target is the element the handler is associated with in the synthetic events system, can be an ancestor of the actual event.target
 * return false to indicate *not handled*, so synthetic event system will continue going up the ancestor tree
 */
export type Handler<E extends Event = Event, T extends EventTarget = EventTarget> = (
  event: E,
  target: T,
) => void | false | Promise<any>

interface Hole<T> {
  fn: () => T | string // prop name
  current_value: T
  inst_or_node: Inst | Node
  prop: string
  deps?: Array<string /*| {obj, path} for global deps*/> // can: not exist (ie holes execute always) or be static - can default to holes that always execute and allow static / dynamic deps as optimization
  owner_inst: Inst // to invoke fn with: required if Holes can be global effects – can get from inst_or_node only if it's inst: inst_or_node.owner_inst ?? inst_or_node.parent_inst
}

/** returned by `$(() => inst.prop)` in `component.create()`*/
class HoleProto<T = any> {
  fn: () => T | string // prop name
  deps?: Array<string>
  constructor(fn: Hole<any>['fn'], deps?: Hole<any>['deps']) {
    this.fn = fn
    if (deps) this.deps = deps
  }
}

export let $ = (fn: Hole<any>['fn'], deps?: Hole<any>['deps']) => new HoleProto(fn, deps)
export let $dyn = (fn: Hole<any>['fn']) => new HoleProto(fn, undefined)

export class Component {
  [key: string]: any

  create?(): El | UITree
  mount?(): void
  update?(): void
  cleanup?(): void
  static _ui_tree?: UITree
  static singleton?: boolean
  static equals?: { [key: string]: (val: any, prev: any) => boolean }
  static owner_comp?: CompClass // needed for _h, see below

  _changed: Map<string, any /* <- previous value */> = new Map()

  _el?: El // TODO? should be Node?
  // if changed to 'el', check partial key syncing that relies on _-prefixed keys

  _el_inst?: Inst // Inst the _el had if _el comes from a component itself, e.g. <div> will have no _el_inst, but <MyComp> will - TODO necessary? should be in _child_insts
  _parent_inst?: Inst
  _child_insts?: Set<Inst> // with only refs, since non-static will have a ref for sure, could just add _static_child_insts instead of all _child_insts - NO, must be able to call unmount on all child insts - either child_insts with is_static flag or iterate through all props to see if there is an inst -> unreliable

  _holes?: Hole<any>[] // when iterating, will need Map<Inst, props> - can update then, or just set values and update after running `update()` - probably not
  _partial_insts?: Set<Inst>

  _owner_inst?: Inst // only partials have owner inst

  _mounted: boolean = false
  _is_static?: boolean

  _anchor?: Node
  _inspos?: InsertPosition
}
export type Inst = Component
type CompClass = typeof Component

export const $inst: unique symbol = Symbol(__DEV__ ? 'inst' : undefined)
export type InstEl<Data extends Inst = Inst> = El & AnyObject & { [$inst]: Data }
/**
 * @param el: can be the root el of Inst or a child with a handler (see {@link listen})
 */
export function el_to_inst_el_is_part_of(el: InstEl): Inst
export function el_to_inst_el_is_part_of(el: Element): undefined
export function el_to_inst_el_is_part_of(el: unknown): unknown {
  return (el as InstEl)[$inst]
}

export type UITree = AnyObject & { _: string | CompClass; ref?: string } // | string | unknown[]

let get_inst = (el_or_inst: InstEl | Inst): Inst =>
  is_node(el_or_inst) ? el_to_inst_el_is_part_of(el_or_inst) : el_or_inst
let inst_to_comp_class = (inst: Inst): CompClass => inst.constructor as CompClass

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region PARTIALS

let handler_or_partial__owner_comp_class = new WeakMap<Handler | UITree, CompClass>()
let partial__comp_class = new WeakMap<UITree, CompClass>()

// this fn exists because _anchor.insertAdjacentElement(_inspos, next_el) can't be used with `Node`s
let insert = (anchor: Node, inspos: InsertPosition, node: Node) => {
  // prettier-ignore
  switch (inspos) {
      // anchor is parent
      case 'afterbegin' : return anchor.insertBefore(node, anchor.firstChild)
      case 'beforeend'  : return anchor.insertBefore(node, null) // anchor.appendChild(node)
      // anchor is sibling - anchor will have parentNode (document.body at least)
      case 'beforebegin': return anchor.parentNode!.insertBefore(node, anchor)
      case 'afterend'   : return anchor.parentNode!.insertBefore(node, anchor.nextSibling)
    }
}

let get_ui_partial_inst = (partial: UITree, current_inst: Inst, partial_update_fn?: () => void) => {
  let owner_comp = handler_or_partial__owner_comp_class.get(partial)
  let partial_comp_class = partial__comp_class.get(partial)
  if (!partial_comp_class) {
    partial_comp_class = class PartialComp extends Component {
      constructor() { super() } // prettier-ignore
      static _ui_tree = partial
      // cannot set `update = partial_update_fn`, because it will override the parent's update in When
      update() { partial_update_fn?.call(this) } // prettier-ignore
      static owner_comp = owner_comp
    }
    partial__comp_class.set(partial, partial_comp_class)
  }
  assert_exists(partial_comp_class)

  let partial_inst = get_inst(_h({ _: partial_comp_class }) as InstEl | Inst) // by using _h, partial_inst should have _parent_inst == current_inst

  let owner_inst = current_inst
  while (inst_to_comp_class(owner_inst) !== owner_comp) owner_inst = owner_inst._parent_inst as Inst // go up the inst tree to get owner_inst, it should always reach parent where partial was defined
  partial_inst._owner_inst = owner_inst

  // partial_inst's child_insts should also have the same owner inst, recursively
  // TODO is this necessary? shouldn't be, since owner_comp is set in h() for partials
  // partial_inst._child_insts?.forEach((ci) => (ci._owner_inst = owner_inst))

  return partial_inst
}

let insert_partial_with_current_inst = (
  partial: UITree | undefined,
  current_inst_key = '_partial' /* TODO? '_el' */,
) => {
  assert_exists(_current_inst)
  let { _anchor, _inspos } = _current_inst
  assert_exists(_anchor) // _anchor set when processing UITree for components that don't create an _el
  let prev = _current_inst[current_inst_key] as Inst // will be there if mounted first
  _current_inst[current_inst_key] = insert_partial(partial, prev, _current_inst, _anchor, _inspos)
}

export let insert_partial = (
  partial: UITree | undefined,
  prev_inst: Inst,
  current_inst: Inst,
  anchor: Node,
  inspos?: InsertPosition,
): Component | undefined => {
  // unmount prev partial
  if (prev_inst) for (let key in prev_inst) if (!key.startsWith('_')) prev_inst._owner_inst![key] = undefined // sync_partial_inst_with_owner_inst

  let prev_node = prev_inst._el
  // only do this if no next partial, otherwise the new partial will replace DOM nodes
  // PROBLEM if there is prev_node and partial but partial does not create a next_node - shouldn't happen
  if (prev_node && !partial) {
    if (inspos) prev_node.parentNode!.removeChild(prev_node)
    else prev_node.parentNode!.replaceChild(anchor, prev_node) // if _anchor is comment node, replace _el with _anchor
  }

  // next
  if (partial) {
    assert_is<UITree>(partial)

    let partial_inst = get_ui_partial_inst(partial, current_inst)
    // sync_partial_inst_with_owner_inst - partials only have _-prefixed keys and don't have props, so any other key can only be a ref
    for (let key in partial_inst) if (!key.startsWith('_')) partial_inst._owner_inst![key] = partial_inst[key] // partials have _owner_inst

    let next_node = partial_inst._el
    if (next_node) {
      // mount
      if (prev_node) prev_node.parentNode!.replaceChild(next_node, prev_node)
      else if (inspos) insert(anchor, inspos, next_node)
      else anchor.parentNode!.replaceChild(next_node, anchor) // if _anchor is comment node, replace _anchor with next_el
      mount(partial_inst) // should mount after inserting in DOM
    } else {
      partial_inst._anchor = anchor
      partial_inst._inspos = inspos
    }
    return partial_inst
  }
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region BUILT-IN COMPONENTS

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region Slot

/*
  when inspos is undefined, it's because anchor_el is a comment node that will get replaced
  
  - fill for first time -> replace comment with node
  - replace -> replace node with node
  - remove -> replace node with comment
  
*/

function assert_changed(inst: Inst, prop: string) {
  if (__DEV__) {
    if (!inst._changed.has(prop)) {
      throw new Error(`Assertion failed: component \`update\`d without prop ${prop} changing in inst ${inst}`)
    }
  }
}

class Slot extends Component {
  declare value: UITree
  update() {
    assert_changed(this, 'value')
    insert_partial_with_current_inst(this.value)
  }
}

export function $slot(ref: string): UITree {
  assert_exists(_current_inst)
  return { _: Slot, ref }
}

export function slot(ref: string, value: UITree) {
  assert_exists(_current_inst)
  let slot_inst = _current_inst[ref] as Inst
  if (slot_inst) update<Slot>(slot_inst, { value })
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region When

class When extends Component {
  declare when: boolean
  declare then: UITree
  declare else?: UITree

  update() {
    assert_exists(_current_inst)
    if (c('when')) insert_partial_with_current_inst(this.when ? this.then : this.else)
  }
}

export function $when(ref: string, then: UITree, _else?: UITree): UITree {
  let res: AnyObject = { _: When, ref, then }
  if (_else) res.else = _else
  return res as UITree
}

// memos, even if it doesn't matter that If is called again, user code for branches
// should only run when they change -> if (when()){user code for then-branch}
// TODO right now it returns `changed`, not whether `then` or `else` are active - what should it return?
let $when_suffix = '__has_changed__'
export function when(when: boolean, ref: string): boolean {
  assert_exists(_current_inst)
  let changed = memo(ref + $when_suffix, when)
  if (changed) {
    let When_inst = _current_inst[ref] as Inst
    if (__DEV__) {
      // if user comments out $when in template, do not throw
      if (!When_inst) {
        console.warn('Missing $when in template: ', ref)
        return false
      }
    }
    update<When>(When_inst, { when })
  }
  return changed
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region Each

class Each extends Component {
  // props
  declare item_template: UITree
  declare item_update: () => void
  declare array: WeakKey[]

  // inst
  declare cache?: WeakMap<any, Inst>
  declare current_dom_nodes?: any[]

  create() { return { _: 'div', style: 'display: contents;' } } // prettier-ignore

  update() {
    if (c('array')) {
      this.cache ??= new WeakMap<any, Inst>() // TODO clean up insts in cache no longer in array? with WeakMap will disappear if obj disappears

      let { cache, array, item_template, item_update } = this

      let next_dom_nodes: El[] = []
      let new_insts: Inst[]
      let new_items: any[]
      for (let item of array) {
        let item_inst = cache.get(item)
        if (!item_inst) {
          assert_exists(_current_inst) // TODO is it `this`?
          item_inst = get_ui_partial_inst(item_template, _current_inst, item_update)
          cache.set(item, item_inst)

          // could just `update(item_inst, item)` here only if update were scheduled (runs in microTask), otherwise must do it after reconcile to ensure it's in the DOM
          ;(new_insts ??= []).push(item_inst)
          ;(new_items ??= []).push(item)
        }
        next_dom_nodes.push(item_inst._el!) // for now, should have ._el - TODO nested When, etc
      }

      assert_is<HTMLElement>(this._el)
      reconcile(this._el, this.current_dom_nodes ?? [], next_dom_nodes)
      // @ts-expect-error
      if (new_insts) for (let i = 0, len = new_insts.length; i < len; i++) update(new_insts[i], new_items[i])

      this.current_dom_nodes = next_dom_nodes
    }

    /* update insts when their obj changes
      we can't access item_instances from outside, so have to rely on global reactivity `set` to update them
      to do so we add the Each inst to effects, its `update` will execute any time anything changes, and inside it will check if it's one of its objs */

    for (let [obj, keys] of changes) {
      let item_inst = this.cache?.get(obj)
      if (item_inst) {
        let props = obj
        // if it has the changed keys - not "whole obj changed" - only pass changed props - TODO could avoid for-loop here and inside update, using trigger_update
        if (keys) { props = {}; for (let [key, _] of keys) props[key] = obj[key] } // prettier-ignore
        // TODO BUG: should not set current_inst to item_inst here: use another global ('each_inst') instead of inst
        // so with in an Each with holes (or item update fn), can use both `each_inst` for the item_inst and `inst` for the parent
        // if there are nested lists: could have yet another, but better to force to put nested list in different component
        update(item_inst, props)
      }
    }
  }
}

export let $each = (
  ref: string,
  item_template: UITree,
  item_update: (item: any, item_inst: Inst & any, i: number) => void,
) => {
  return { _: Each, ref, template: item_template, update_fn: item_update }
}
export let each = (ref: string, array_or_array_key: any[] | string /*, item_update?: any*/) => {
  assert_exists(_current_inst)
  let Each_inst = _current_inst[ref] as Inst
  // if (c(array_key)) {
  let array = is_str(array_or_array_key) ? _current_inst[array_or_array_key] : array_or_array_key
  update<Each>(Each_inst, { array })
  // }
}

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region Reconcile arrays

export let reconcile = (parent_node: Element, a0: Element[], a1: Element[]) => {
  if (empty(a1)) parent_node.textContent = ''
  else if (a1.length == 1) parent_node.replaceChildren(a1[0])
  else {
    a0 ??= [] //parent_node.childNodes //TODO? [...parent_node.childNodes]
    if (empty(a0)) parent_node.append(...a1)
    else reconcileArrays(parent_node, a0, a1)
  }
}

// From Solid:

// Slightly modified version of: https://github.com/WebReflection/udomdiff/blob/master/index.js
function reconcileArrays(parentNode: Element, a: Element[], b: Element[]) {
  let bLength = b.length,
    aEnd = a.length,
    bEnd = bLength,
    aStart = 0,
    bStart = 0,
    after = a[aEnd - 1].nextSibling,
    map = null

  while (aStart < aEnd || bStart < bEnd) {
    // common prefix
    if (a[aStart] === b[bStart]) {
      aStart++
      bStart++
      continue
    }
    // common suffix
    while (a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--
      bEnd--
    }
    // append
    if (aEnd === aStart) {
      const node = bEnd < bLength ? (bStart ? b[bStart - 1].nextSibling : b[bEnd - bStart]) : after

      while (bStart < bEnd) {
        parentNode.insertBefore(b[bStart++], node)
      }
      // remove
    } else if (bEnd === bStart) {
      while (aStart < aEnd) {
        //@ts-ignore
        if (!map || !map.has(a[aStart])) {
          a[aStart].remove()
        }
        aStart++
      }
      // swap backward
    } else if (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]) {
      const node = a[--aEnd].nextSibling
      parentNode.insertBefore(b[bStart++], a[aStart++].nextSibling)
      parentNode.insertBefore(b[--bEnd], node)

      a[aEnd] = b[bEnd]
      // fallback to map
    } else {
      if (!map) {
        //@ts-ignore
        map = new Map()
        let i = bStart
        //@ts-ignore
        while (i < bEnd) map.set(b[i], i++)
      }
      //@ts-ignore
      const index = map.get(a[aStart])
      if (index != null) {
        if (bStart < index && index < bEnd) {
          let i = aStart,
            sequence = 1,
            t

          while (++i < aEnd && i < bEnd) {
            //@ts-ignore
            if ((t = map.get(a[i])) == null || t !== index + sequence) break
            sequence++
          }

          if (sequence > index - bStart) {
            const node = a[aStart]
            while (bStart < index) parentNode.insertBefore(b[bStart++], node)
          } else parentNode.replaceChild(b[bStart++], a[aStart++])
        } else aStart++
      } else a[aStart++].remove()
    }
  }
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region EVENTS

/**
 * invoked during event handling
 * fns passed as prop to a component instance are associated to the component they come from
 */
let handler_to_owner_inst = (handler: Handler, target: Element): Inst | undefined => {
  // if `listen` was called while processing template, it will have inst, otherwise inst will be undefined (handler doesn't need an inst)
  let owner_inst = el_to_inst_el_is_part_of(target) as Inst | undefined
  let owner_comp = handler_or_partial__owner_comp_class.get(handler) // no component means owner_inst == el_inst ie _current_inst when `listen` was called
  if (owner_inst && owner_comp)
    while (owner_inst && inst_to_comp_class(owner_inst) !== owner_comp)
      owner_inst = owner_inst._parent_inst as Inst // it should always reach parent where fn was defined
  return owner_inst
}

let event_prefix = '__'
/* modified from https://github.com/Freak613/stage0/blob/master/syntheticEvents.js */
let global_event_listener = (e: Event) => {
  let { type } = e,
    target = e.target as Element | null // synthetic events only used for regular Elements - not window, document, or others
  while (target) {
    // @ts-expect-error
    let handler = target[event_prefix + type]
    if (handler) {
      let handler_inst = handler_to_owner_inst(handler, target)
      let res = with_current_inst(handler_inst, handler, e, target) // here `handler` called with `handler_inst` as `this`
      if (res !== false) return // if handler returns false, continue until we find another handler
    }
    target = target.parentElement
  }
}

export function listen(el: Element, event_name: string, handler: Handler<any, any>) {
  if (__DEV__) { let str = handler.toString(); if (str.startsWith('(') /* is arrow fn */ && str.includes('this')) console.warn("If your handler acceses `this` in a component, you should write it as a `function` instead of an arrow function (`() => {}`), because `this` in arrow functions cannot be rebound.") } // prettier-ignore

  document.addEventListener(event_name, global_event_listener) // adding the same listener twice has no effect

  // @ts-expect-error
  el[event_prefix + event_name] = handler

  if (_current_inst) (el as InstEl)[$inst] = _current_inst
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region CREATE

// stack, update may call a child component's update
let _insts: Inst[] = [],
  _current_inst: Inst | undefined

export let inst = _current_inst as Inst

let with_current_inst = (new_inst: Inst | undefined, fn: Function, arg1?: any, arg2?: any) => {
  if (_current_inst) _insts.push(_current_inst)
  _current_inst = new_inst as Inst
  let res = fn.call(new_inst, arg1, arg2) // `fn.call` with `new_inst` as `this` needed only for handlers, see global_event_listener
  _current_inst = _insts.pop() as Inst
  return res
}

let svg_tags = new Set(['svg', 'path']),
  is_svg = (s: string) => svg_tags.has(s)
let process_tag = (tag: string): El => {
  let el
  let starts_with_dot = tag.startsWith('.')
  if (starts_with_dot || tag.startsWith('#')) {
    el = document.createElement('div')
    el[starts_with_dot ? 'className' : 'id'] = tag.slice(1)
  } else
    el = is_svg(tag)
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag)

  return el
}
let process_tag_prop = (el: Element, prop_key: string, value: any) => {
  switch (prop_key) {
    case 'ref':
      assert_exists(_current_inst)
      _current_inst[value as string] = el //refs are strings
      break
    case 'class':
      if (is_str(value)) {
        if (el instanceof SVGElement) el.setAttribute('class', value)
        else el.className = value
      } /* is obj */ // else classList(el, next_value, prev_value)
      break
    case 'style':
      assert(el instanceof HTMLElement)
      el.style.cssText = value
      break
    case 'children':
      if (is_array(value)) {
        let last_appended_child: Node | undefined // Element | Text | undefined
        let pending_slot: Inst | undefined
        for (let i = 0, len = value.length; i < len; i++) {
          let child_node_or_inst = process_tag_child(el, value[i] as Element | Text | UITree) // user should only pass those types as children
          if (!is_node(child_node_or_inst)) {
            assert_exists(_current_inst)
            let inst = child_node_or_inst as Inst
            // resolve pending slot from last iteration: this iteration is_hole, so must create comment node
            if (pending_slot) {
              let comment_node = document.createComment('')
              el.appendChild(comment_node)

              // inspos undefined here means comment node will get replaced
              pending_slot._anchor = comment_node
              pending_slot = undefined
            }

            let anchor: Node | undefined // Element | Text | undefined
            let inspos: InsertPosition
            if (i == 0) {
              inspos = 'afterbegin'
              anchor = el
            } else if (i == len - 1) {
              inspos = 'beforeend'
              anchor = el
            } else if (last_appended_child) {
              inspos = 'afterend'
              anchor = last_appended_child
            } else pending_slot = inst

            if (anchor) {
              inst._anchor = anchor
              // @ts-expect-error - inspos will exist if anchor exists
              inst._inspos = inspos
            }
            last_appended_child = undefined // should happen at the end of the scope in case we use last iteration's value
          } else {
            assert_is_node(child_node_or_inst)
            let node = child_node_or_inst

            if (pending_slot) {
              // resolve pending slot from last iteration: this iteration has child_el, so can anchor to it
              assert_exists(_current_inst)
              pending_slot._inspos = 'beforebegin'
              pending_slot._anchor = node // text node is safe to use even with translations, which currently only change its textContent (not changing the Text for another one) - BUG: clone text node
              pending_slot = undefined
            }
            last_appended_child = node // should happen at the end of the scope in case we use last iteration's value
          }
        }
      } /* if children is not array */ else {
        let child_node_or_inst = process_tag_child(el, value)
        if (!is_node(child_node_or_inst)) {
          assert_exists(_current_inst)
          child_node_or_inst._anchor = el
          child_node_or_inst._inspos = 'afterbegin'
        }
      }
      break
    default:
      if (is_fn(value)) listen(el, prop_key, value as Handler) // fn must be a Handler
      else if (value == null) el.removeAttribute(prop_key)
      else el.setAttribute(prop_key, value)
  }
}
let process_tag_child = (el: Element, v: Node | Text | UITree): Node | Inst => {
  let child_node_or_inst
  // TODO disallow `Node`s in templates?
  if (is_node(v)) {
    let is_singleton = _current_inst && inst_to_comp_class(_current_inst).singleton // Singletons: Can make sense to not clone, if user wants to use a specific node in a singleton component
    child_node_or_inst = is_singleton ? v : v.cloneNode(true)
  } else child_node_or_inst = _h(v)
  if (is_node(child_node_or_inst)) el.appendChild(child_node_or_inst) // PERF .append() faster?
  return child_node_or_inst
}

let insts_pool = new Map<CompClass, Array<Inst>>() // TODO - or delete this and have do it in userland by having the component constructor return an inst from the pool

let process_hole = (inst_or_node: Inst | Node, prop: string, static_hole: HoleProto) => {
  assert_exists(_current_inst)
  ;(_current_inst._holes ??= []).push({
    fn: static_hole.fn,
    deps: static_hole.deps,
    current_value: undefined,
    inst_or_node,
    prop,
    owner_inst: _current_inst,
  })
}

let _h = (arg: UITree): El | Inst => {
  let el: El | undefined
  let { _: tag /*= 'div' TODO*/ } = arg
  if (is_str(tag)) {
    el = process_tag(tag)
    for (let prop_key in arg)
      if (!prop_key.startsWith('_')) {
        let prop_value = arg[prop_key]
        if (prop_value instanceof HoleProto) process_hole(el, prop_key, prop_value)
        else process_tag_prop(el, prop_key, prop_value)
      }
  } /* is component */ else {
    let comp = tag
    let tag_inst = insts_pool.get(comp)?.pop()
    let did_not_have_tag_inst = !tag_inst
    if (did_not_have_tag_inst) tag_inst = new comp()
    assert_exists(tag_inst)

    //#region process_inst_props

    let is_static_inst = true // no ref or holes; ref means it should be further `update`d in parent `update()`
    let props = arg
    for (let prop_key in props)
      if (!prop_key.startsWith('_')) {
        let prop_value = props[prop_key]

        // we are processing a template
        if (_current_inst) {
          if (prop_value instanceof HoleProto) {
            is_static_inst = false
            process_hole(tag_inst, prop_key, prop_value)
            continue
          }
          // associate handler to component
          // any array or obj could be a partial, we mark them as such just in case - TODO could put special key in obj (or just "_") to distinguish partial from regular obj
          else if (is_fn(prop_value) || is_arr_or_obj(prop_value)) {
            let curr_comp = inst_to_comp_class(_current_inst)
            handler_or_partial__owner_comp_class.set(prop_value as any, curr_comp.owner_comp ?? curr_comp) // owner_comp set in `partial` when processing a partial inst that itself has a partial/handler
          } else if (prop_key == 'ref') {
            is_static_inst = false // ref means it will be further updated in update
            assert_exists(_current_inst)
            assert(is_str(prop_value)) // refs are strings
            _current_inst[prop_value] = tag_inst
            continue
          }
        }

        tag_inst._changed.set(prop_key, undefined)
        tag_inst[prop_key] = prop_value
      }

    if (is_static_inst) tag_inst._is_static = true
    //#endregion

    //#region finish inst creation
    if (did_not_have_tag_inst) {
      if (!comp._ui_tree) {
        let el_or_ui_tree = tag_inst.create?.()
        if (is_node(el_or_ui_tree)) {
          // if create returns DOM
          ;(el_or_ui_tree as InstEl)[$inst] = tag_inst
          tag_inst._el = el_or_ui_tree
        } else if (exists(el_or_ui_tree)) comp._ui_tree = el_or_ui_tree // if create returns UITree
      }
      // no `else`, this is intentional - will have ui_tree only if create does not return DOM node
      if (comp._ui_tree) {
        let el_or_child_inst = with_current_inst(tag_inst, _h, comp._ui_tree) as InstEl | Inst

        if (is_node(el_or_child_inst)) {
          let child_inst = el_to_inst_el_is_part_of(el_or_child_inst)
          if (child_inst)
            tag_inst._el_inst = child_inst // if el already has an inst (eg because inside component the first child was <Container>), save it in _el_inst
            // rewrite that element's inst to this one
          ;(el_or_child_inst as InstEl)[$inst] = tag_inst
          tag_inst._el = el_or_child_inst
        } else {
          // el_or_child_inst is inst, and has no ._el - TODO change this to check ._el if we always return inst
        }
      }

      if (_current_inst) {
        tag_inst._parent_inst = _current_inst
        ;(_current_inst._child_insts ??= new Set()).add(tag_inst)
      }
    }
    //#endregion

    el = tag_inst._el
    if (!el) return tag_inst
  }

  return el as El // here there will always be an El
}
/** When used outside template fns, should not use When/Each, so will always return El */
export let h = _h as (arg: UITree) => El

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region UPDATE

//// update helpers

// TODO cls helper can take an existing ref and store prev classes in <ref>_prev_classes to diff
// let cls = (_ref: string, _obj_or_str: any) => {}

/** allows setting a default value for a prop in `update` - TODO not needed since we have _first_update */
export let default_value = (key: string, val: any) => {
  // _memo(_current_inst!, key, val, _current_inst![key] === undefined)
  assert_exists(_current_inst)
  let inst = _current_inst
  if (inst[key] === undefined) {
    inst._changed.set(key, undefined)
    inst[key] = val
  }
}

// arr or obj considered changed even if it's the same reference - in update, if an arr/obj is passed as prop to update fn, it will always be considered changed
let default_equals = (val: any, prev: any) => (is_arr_or_obj(val) ? false : val === prev)

let _memo = (inst: Inst, key: string, val: any, has_changed?: boolean): boolean => {
  // has_changed is not a fn - don't want to create a new fn every update
  has_changed ??= !(inst_to_comp_class(inst).equals?.[key] ?? default_equals)(val, inst[key])
  if (has_changed) inst[key] = val
  return has_changed
}
export let memo = (key: string, val: any, has_changed?: any) => _memo(_current_inst!, key, val, has_changed)

export let c = (
  p0: string,
  p1?: string,
  p2?: string,
  p3?: string,
  p4?: string,
  p5?: string,
  p6?: string,
  p7?: string,
  p8?: string,
  p9?: string,
): boolean => {
  assert_exists(_current_inst)
  return changed(_current_inst, p0, p1, p2, p3, p4, p5, p6, p7, p8, p9)
}

////

let update_holes = (inst: Inst) => {
  if (inst._holes) {
    let inst__hole_values: Map<Inst, AnyObject> | undefined
    for (let hole of inst._holes) {
      // TODO invoke with the right owner `inst` and `each_inst`
      assert_exists(_current_inst)
      let v = is_str(hole.fn) ? _current_inst[hole.fn] : hole.fn()
      // TODO custom equals
      if (v != hole.current_value) {
        let { inst_or_node, prop } = hole
        if (inst_or_node instanceof Component) {
          let values = (inst__hole_values ??= new Map()).get(inst_or_node) ?? {}
          values[prop] = v
          inst__hole_values.set(inst_or_node, values)
        } else process_tag_prop(inst_or_node as Element, prop, v)
        hole.current_value = v
      }
    }
    if (inst__hole_values) for (let [inst, props] of inst__hole_values) update(inst, props)
  }
}

let _update_inst = () => {
  let inst = _current_inst!

  // FOR NOW: insts don't hold global subscriptions, they guard inside with `changed`, all effects are run

  // mount static child insts
  if (!inst._mounted && inst._child_insts)
    for (let child_inst of inst._child_insts) if (child_inst._is_static) trigger_update(child_inst) // this should work for ._el_inst as well, just another static inst

  if (inst._mounted) inst.cleanup?.()
  else { inst.mount?.(); inst._mounted = true } // prettier-ignore

  update_holes(inst)

  if (inst._partial_insts) for (let partial_inst of inst._partial_insts) update_holes(partial_inst)

  // update should happen after mounting static child insts, right? ie if top_level_child_inst is <Container><div ref='within_partial'/></Container> and has children with refs,
  // should mount static child insts first, so the partial kicks in, and we can reference the refs

  // not a problem: if both parent and child use global get(), child will come first in effects graph, but parent won't update a static inst anyway
  inst.update?.()

  inst._changed.clear()
}
export let trigger_update = (inst: Inst) => with_current_inst(inst._owner_inst ?? inst, _update_inst, inst)

export let update = <Props extends Component>(
  el_or_inst: InstEl | Inst,
  props: Partial<Props>,
  should_trigger_update = true,
) => {
  let inst = get_inst(el_or_inst) as Props
  for (let key in props) {
    // _memo(inst, key, props[key])
    let val = props[key]
    let prev = inst[key]
    let has_changed = !(inst_to_comp_class(inst).equals?.[key] ?? default_equals)(val, prev)
    if (has_changed) inst._changed.set(key, prev)
    // @ts-expect-error
    inst[key] = val
  }
  if (should_trigger_update && !empty(inst._changed)) trigger_update(inst)
}

export let mount = (inst: Inst, where?: HTMLElement) => {
  // should come first, in case we want to do something like `getBoundingClientRect`
  where?.appendChild(inst._el!) // TODO Fragment / When / Each?
  trigger_update(inst)
}

export let unmount = (inst: Inst) => {
  inst.cleanup?.()
  effects.delete(inst)
  if (inst._child_insts) for (let child_inst of inst._child_insts) unmount(child_inst)
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region GLOBAL REACTIVITY

// Run all effects on every change (changes can be batched) - no way to check if an effect is listening for a specific change
// rationale for this is a given change in a UI usually happens when the data it affects is shown

type Effect = Inst | { cleanup?(): void; update(): void | (() => void) /* can return cleanup fn */ }
let _current_effect: Effect | undefined
let get_current_effect = (): Effect => _current_effect ?? _current_inst!

// TODO iterable weakset for effects? otherwise must manually remove
let prev_effects = new Set<Effect>()
let effects = new Set<Effect>()

// signature can be Map<any, Set<string> | undefined> - where keys in the map are changed objs (pojo/array/map/set) and values either don't apply (eg for array, maybe for set), or a set of changed keys
//               or Map<any, Map<k,v> | undefined> - where values are maps that hold previous value, like in components
// if we want to store Set previous values: Map <any, any>
export let changes = new Map<any, Map<string, any> | undefined>() // could be WeakMap but we want to iterate it in Each - using some kind of iterable WeakMap would avoid needing to `effects.delete(inst)` in unmount

export let changed = (
  o: any,
  p0?: string,
  p1?: string,
  p2?: string,
  p3?: string,
  p4?: string,
  p5?: string,
  p6?: string,
  p7?: string,
  p8?: string,
  p9?: string,
): boolean => {
  let keys_set_or_map: Set<string> | Map<string, any> | undefined
  if (o instanceof Component) {
    if (!p0) return !empty(o._changed)
    keys_set_or_map = o._changed
  } else {
    effects.add(get_current_effect())
    if (!p0) return changes.has(o)
    keys_set_or_map = changes.get(o)
    if (!keys_set_or_map) return false
  }
  return (
    keys_set_or_map.has(p0) ||
    (p1 != null && keys_set_or_map.has(p1)) ||
    (p2 != null && keys_set_or_map.has(p2)) ||
    (p3 != null && keys_set_or_map.has(p3)) ||
    (p4 != null && keys_set_or_map.has(p4)) ||
    (p5 != null && keys_set_or_map.has(p5)) ||
    (p6 != null && keys_set_or_map.has(p6)) ||
    (p7 != null && keys_set_or_map.has(p7)) ||
    (p8 != null && keys_set_or_map.has(p8)) ||
    (p9 != null && keys_set_or_map.has(p9))
  )
}

// swap obj for another obj, keeping effects
export let swap = (old_obj: any, new_obj: any) => {
  let old_value = changes.get(old_obj)! // old_obj must be present in the set
  changes.set(new_obj, old_value)
  changes.delete(old_obj)
}

// analogous to update / trigger_update, but for effects
export let set = (
  o: AnyObject | Map<any, any> | Set<any> | Array<any>,
  props: any,
  should_trigger_effects = true,
) => {
  if (props) {
    // for arrays and sets there won't be a props arg - just set(array) to trigger effects
    assert_is<AnyObject | Map<any, any>>(o)
    let is_map = o instanceof Map
    // same logic as update
    for (let key in props) {
      let val = props[key]
      let prev = is_map ? (o as Map<any, any>).get(key) : (o as AnyObject)[key]
      let has_changed = default_equals(val, prev)
      if (has_changed) {
        let map = changes.get(o)
        if (!map) { map = new Map(); changes.set(o, map) } //prettier-ignore
        map.set(key, prev)
      }
      if (is_map) (o as Map<any, any>).set(key, val)
      else (o as AnyObject)[key] = val
    }
  } else changes.set(o, undefined)

  if (should_trigger_effects) trigger_effects()
}

export let trigger_effects = () => {
  let current_effects = effects
  effects = prev_effects // so that new effect subscritions are created on an empty Set
  for (let eff of current_effects) {
    if (eff instanceof Component) trigger_update(eff)
    else {
      _current_effect = eff
      eff.cleanup?.()
      let new_cleanup = eff.update()
      if (new_cleanup) eff.cleanup = new_cleanup
    }
  }
  changes.clear()
  current_effects.clear()
  prev_effects = current_effects
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/

/*--------------------------------------------------------------------------------------------------------------------------------------------*/
//#region JSX

//// basic JSX with jsxFactory - could be optimized, and could add whether an object passed as a prop is a partial (e.g. $partial symbol)

// put this in a .d.ts file for error "JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists."
declare namespace JSX {
  interface IntrinsicElements {
    div: { [key: string]: any }
    span: { [key: string]: any }
    // Add more elements as needed
    [elemName: string]: any
  }
}

// @ts-expect-error
export let jsxFactory = (tag, props, ...children) => {
  let res = props ?? {}
  res._ = tag
  if (children.length > 0) {
    if (children.length == 1) res.children = children[0]
    else res.children = children
  }
  return res
}

//#endregion
/*--------------------------------------------------------------------------------------------------------------------------------------------*/
