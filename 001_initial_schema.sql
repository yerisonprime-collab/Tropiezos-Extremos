-- Perfiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 16),
  avatar_url text,
  level int not null default 1,
  experience int not null default 0,
  coins int not null default 0 check (coins >= 0),
  crowns int not null default 0,
  wins int not null default 0,
  games_played int not null default 0,
  created_at timestamptz not null default now()
);

create table public.match_history (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  match_id uuid not null,
  position int not null,
  reward_coins int not null,
  created_at timestamptz not null default now(),
  unique (player_id, match_id) -- evita duplicar recompensas
);
create index on public.match_history (player_id, created_at desc);

-- RLS: lectura permitida, escritura solo desde el servidor (service_role ignora RLS)
alter table public.profiles enable row level security;
alter table public.match_history enable row level security;
create policy "perfiles visibles" on public.profiles for select using (true);
create policy "historial propio" on public.match_history for select using (auth.uid() = player_id);
-- No hay políticas de insert/update/delete: el navegador no puede tocar monedas, coronas ni victorias.

-- Perfil automático al registrarse
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(nullif(left(new.raw_user_meta_data->>'username', 16), ''), 'jugador' || substr(new.id::text, 1, 6)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Recompensa de partida (solo la llama el servidor con service_role)
create function public.award_match(p_player uuid, p_match uuid, p_position int, p_coins int) returns void
language plpgsql security definer set search_path = public as $$
declare won boolean := p_position = 1; xp int := 20 + case when p_position < 99 then 30 else 0 end;
begin
  if p_coins < 0 or p_coins > 200 then raise exception 'recompensa inválida'; end if;
  insert into match_history (player_id, match_id, position, reward_coins) values (p_player, p_match, p_position, p_coins);
  update profiles set coins = coins + p_coins, games_played = games_played + 1,
    wins = wins + won::int, crowns = crowns + won::int, experience = experience + xp,
    level = 1 + (experience + xp) / 100
  where id = p_player;
end $$;
revoke all on function public.award_match from public, anon, authenticated;
grant execute on function public.award_match to service_role;
