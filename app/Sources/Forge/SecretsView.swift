// SecretsView — the vault, in the app.
//
// Adding a secret goes through scripts/forge-secrets.js and nothing else, so
// the registry format, the env-var table and the resolution rules have one
// implementation — and the value is written exactly once.
//
// This file used to ALSO write the value itself through the Security framework
// (SecItemAdd), on the theory that doing so kept it out of argv. That theory
// was wrong, and the mistake is worth recording because it reads as an
// improvement: the engine call happened immediately afterwards regardless, and
// the engine's `security add-generic-password` requires the value in argv
// (`-w` — verified, and documented at scripts/forge-secrets.js:25-31, since
// passing it on stdin stores an empty string). The value was therefore exposed
// to `ps` either way; the framework write avoided no exposure at all.
//
// What it did add was a cost. An item created by SecItemAdd carries an ACL
// trusting the creating binary's code signature, and this app is ad-hoc signed
// — its cdhash changes on every rebuild. So each later read by `security(1)`
// came from an "unknown" binary and macOS prompted for authorisation, over and
// over. Removing the write removes the prompt; the item the engine creates is
// plain and readable by the CLI without a dialog.

import SwiftUI
import ForgeKit

// MARK: - Model

struct StoredSecret: Codable, Identifiable, Hashable {
    let service: String
    let name: String
    let env_var: String
    let note: String?
    let store: String?
    let added_at: String?
    let has_secret: Bool?
    let is_default: Bool?
    /// Set by the engine only when verification was asked for AND the vault
    /// could not be read. It splits the two reasons `has_secret` is nil.
    let verify_failed: Bool?

    var id: String { "\(service)/\(name)" }
    var isDefault: Bool { is_default ?? false }
    /// nil means "not checked", which is the default: verifying costs one
    /// Keychain access per entry, and an ad-hoc signed bundle gets an
    /// authorisation dialog for each. Only `false` means actually missing.
    var secretMissing: Bool { has_secret == false }
    /// We looked and could not tell. Distinct from "we did not look", and it
    /// must never be shown as absence — the value is probably there.
    var vaultUnreadable: Bool { verify_failed == true }
}

// MARK: - Store

@MainActor
final class SecretsStore: ObservableObject {
    @Published private(set) var secrets: [StoredSecret] = []
    @Published private(set) var services: [String] = []
    @Published var error: String?

    var byService: [String: [StoredSecret]] {
        Dictionary(grouping: secrets, by: \.service)
    }

    /// Listing never verifies. `verifyAll()` exists for when the user asks.
    func load(verify: Bool = false) {
        var args = ["--list", "--json"]
        if verify { args.append("--verify") }
        secrets = ForgeCore.runJSON([StoredSecret].self, "forge-secrets.js", args) ?? []
        if let rows = ForgeCore.runJSON([ServiceRow].self,
                                        "forge-secrets.js", ["--services", "--json"]) {
            services = rows.map(\.service).sorted()
        }
    }

    struct ServiceRow: Codable { let service: String; let env: String }

    /// Hand the value and its metadata to the engine in a single call: it
    /// writes the secret and registers the entry together. One writer, so the
    /// registry and the vault cannot disagree about what exists.
    func add(service: String, name: String, secret: String, note: String) -> Bool {
        let svc = service.trimmingCharacters(in: .whitespaces).lowercased()
        let nm = name.trimmingCharacters(in: .whitespaces)
        guard !svc.isEmpty, !nm.isEmpty, !secret.isEmpty else {
            error = "serviço, nome e segredo são obrigatórios"
            return false
        }

        // The engine is the only writer, of both the value and the registry
        // entry. Its failure is the only failure mode there is, which is why
        // the guard below must keep reporting it instead of returning quietly.
        var args = ["--add", svc, nm]
        if !note.trimmingCharacters(in: .whitespaces).isEmpty {
            args += ["--note", note]
        }
        let r = ForgeCore.runWithInput("forge-secrets.js", args, input: secret)
        guard r.ok else {
            error = r.stderr.isEmpty ? "falha ao registrar" : r.stderr
            return false
        }
        error = nil
        load()
        return true
    }

    /// One round of Keychain prompts, on request — the price of an answer the
    /// user asked for, rather than one they got for opening a screen.
    func verifyAll() { load(verify: true) }

    func remove(_ s: StoredSecret) {
        let r = ForgeCore.run("forge-secrets.js", ["--remove", s.service, s.name])
        if !r.ok { error = r.stderr }
        load()
    }

    func setDefault(_ s: StoredSecret) {
        let r = ForgeCore.run("forge-secrets.js", ["--default", s.service, s.name])
        if !r.ok { error = r.stderr }
        load()
    }

    func copyExecCommand(_ s: StoredSecret, state: AppState) {
        state.copyToPasteboard(
            "forge-secrets exec \(s.service) \(s.name) -- <comando>", label: "Comando")
    }
}

// MARK: - View

struct SecretsView: View {
    @StateObject private var store = SecretsStore()
    @ObservedObject var state: AppState
    @State private var adding = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                intro
                if let e = store.error {
                    Label(e, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                }
                if store.secrets.isEmpty {
                    empty
                } else {
                    ForEach(store.byService.keys.sorted(), id: \.self) { svc in
                        serviceSection(svc, store.byService[svc] ?? [])
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Segredos")
        .onAppear { store.load() }
        .sheet(isPresented: $adding) {
            AddSecretSheet(store: store, isPresented: $adding)
        }
        .toolbar {
            ToolbarItem {
                Button { store.verifyAll() } label: {
                    Label("Verificar", systemImage: "checkmark.shield")
                }
                .help("Confere se cada valor está no cofre — o macOS vai pedir autorização")
            }
            ToolbarItem {
                Button { adding = true } label: {
                    Label("Adicionar", systemImage: "plus")
                }
            }
        }
    }

    private var intro: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 16)).foregroundStyle(Color.accentOrange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Guardados no Keychain").font(.callout).bold()
                Text("O valor nunca é exibido nem copiável. Listar não abre o Keychain — só \"Verificar\" faz isso, e por isso o macOS pede autorização ali.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
    }

    private func serviceSection(_ service: String, _ items: [StoredSecret]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Text(service).font(.callout).bold()
                if let v = items.first?.env_var {
                    Text(v).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text(items.count == 1 ? "1 segredo" : "\(items.count) segredos")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { idx, s in
                    if idx > 0 { Divider().opacity(0.4) }
                    SecretRow(secret: s, store: store, state: state,
                              siblings: items.count)
                }
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum segredo guardado", systemImage: "key")
                .font(.callout)
            Text("Guarde tokens de CLIs (railway, vercel, fly…) e chaves de MCPs. Vários do mesmo serviço convivem — o nome é seu.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar segredo…") { adding = true }.controlSize(.small)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct SecretRow: View {
    let secret: StoredSecret
    @ObservedObject var store: SecretsStore
    @ObservedObject var state: AppState
    let siblings: Int
    @State private var confirmingRemove = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: secret.secretMissing ? "key.slash" : "key.fill")
                .font(.caption)
                .foregroundStyle(secret.secretMissing ? AnyShapeStyle(Color.orange)
                                 : (secret.has_secret == true ? AnyShapeStyle(Color.green)
                                                              : AnyShapeStyle(.secondary)))
                .frame(width: 16)
                .help(secret.vaultUnreadable
                      ? "Não foi possível ler o cofre — o valor pode estar lá"
                      : (secret.has_secret == nil ? "Valor não verificado"
                         : (secret.secretMissing ? "Sem valor no cofre" : "Valor presente")))

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(secret.name).font(.system(size: 13))
                    if secret.isDefault {
                        Text("padrão").font(.caption2)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                            .help("Usado quando o comando não diz qual")
                    }
                }
                if let n = secret.note, !n.isEmpty {
                    Text(n).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                if secret.secretMissing {
                    Text("registrado sem valor no cofre — readicione")
                        .font(.caption2).foregroundStyle(.orange)
                }
            }
            Spacer()

            if let store = secret.store {
                Text(store).font(.caption2).foregroundStyle(.tertiary)
                    .help(store == "keychain" ? "Guardado no Keychain"
                                              : "Guardado em arquivo 0600 (Keychain indisponível)")
            }

            IconMenu(help: "Opções") {
                Button("Copiar comando de uso") { store.copyExecCommand(secret, state: state) }
                if siblings > 1 && !secret.isDefault {
                    Button("Tornar padrão de \(secret.service)") { store.setDefault(secret) }
                }
                Divider()
                Button("Remover…", role: .destructive) { confirmingRemove = true }
            }
        }
        .padding(.vertical, 9)
        .confirmationDialog("Remover \(secret.id)?",
                            isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remover", role: .destructive) { store.remove(secret) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Apaga o registro e o valor do Keychain. O que já usa este segredo passa a falhar.")
        }
    }
}

struct AddSecretSheet: View {
    @ObservedObject var store: SecretsStore
    @Binding var isPresented: Bool

    @State private var service = ""
    @State private var name = ""
    @State private var secret = ""
    @State private var note = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Novo segredo").font(.headline)

            HStack(spacing: 8) {
                TextField("serviço", text: $service)
                    .textFieldStyle(.roundedBorder).frame(width: 150)
                Menu {
                    ForEach(store.services, id: \.self) { s in
                        Button(s) { service = s }
                    }
                } label: {
                    Image(systemName: "list.bullet")
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Serviços conhecidos")

                TextField("nome (ex: producao, cliente-x)", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            // SecureField: the value is never rendered on screen, and it goes
            // to the engine on stdin rather than being typed into a shell.
            SecureField("segredo", text: $secret)
                .textFieldStyle(.roundedBorder)

            TextField("nota (opcional)", text: $note)
                .textFieldStyle(.roundedBorder)

            Text("Vários nomes do mesmo serviço convivem. O valor é gravado direto no cofre — não fica no histórico do shell.")
                .font(.caption2).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Guardar") {
                    if store.add(service: service, name: name, secret: secret, note: note) {
                        isPresented = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(service.isEmpty || name.isEmpty || secret.isEmpty)
            }
        }
        .padding(20).frame(width: 470)
        .onAppear { store.load() }
    }
}
