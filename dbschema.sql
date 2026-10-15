-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text,
  created_at timestamp without time zone DEFAULT now(),
  phone text,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE TABLE public.teams (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT teams_pkey PRIMARY KEY (id)
);
CREATE TABLE public.team_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member'::text CHECK (role = ANY (ARRAY['member'::text, 'admin'::text, 'installer'::text])),
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  installer_group_id uuid,
  CONSTRAINT team_members_pkey PRIMARY KEY (id),
  CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id),
  CONSTRAINT team_members_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id),
  CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.installer_groups (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  site text NOT NULL DEFAULT 'example'::text,
  address text NOT NULL,
  org_nr text NOT NULL DEFAULT 'test'::text,
  FORMEL numeric NOT NULL DEFAULT '1'::numeric,
  0-72 numeric NOT NULL DEFAULT '1'::numeric,
  72-150 numeric NOT NULL DEFAULT '1'::numeric,
  150-300 numeric NOT NULL DEFAULT '1'::numeric,
  300-600 numeric NOT NULL DEFAULT '1'::numeric,
  600-1000 numeric NOT NULL DEFAULT '1'::numeric,
  1000+ numeric NOT NULL DEFAULT '1'::numeric,
  CONSTRAINT installer_groups_pkey PRIMARY KEY (id),
  CONSTRAINT installer_groups_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id)
);
CREATE TABLE public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  installer_group_id uuid NOT NULL,
  assigned_to uuid,
  person_info text,
  birth_date timestamp without time zone,
  company text,
  address text DEFAULT ''::text,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  priority text DEFAULT 'iron'::text,
  own_consumption numeric,
  voltage numeric,
  phases numeric,
  roof_type_id uuid,
  roof_slope numeric,
  roof_age numeric,
  electricity_price_avg numeric,
  main_fuse numeric,
  status numeric NOT NULL DEFAULT '0'::numeric,
  email text,
  phone text,
  mobile text,
  role text,
  note text,
  created_by uuid,
  org_nr text,
  updated_price numeric,
  lead_source text,
  CONSTRAINT leads_pkey PRIMARY KEY (id),
  CONSTRAINT leads_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id),
  CONSTRAINT leads_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id),
  CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id),
  CONSTRAINT leads_roof_type_id_fkey FOREIGN KEY (roof_type_id) REFERENCES public.roof_types(id),
  CONSTRAINT leads_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.estimates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  image_url text,
  total_panels numeric,
  selected_panel_type text,
  selected_roof_type text,
  checked_roof_data jsonb,
  selected_el_price numeric,
  yearly_cost numeric,
  yearly_cost2 numeric,
  yearly_prod numeric,
  desired_kwh numeric,
  coverage_percentage numeric,
  price_data jsonb,
  address text,
  name text,
  finished boolean NOT NULL DEFAULT false,
  private boolean NOT NULL DEFAULT false,
  kwp numeric,
  simulation_pdf text,
  signed_at timestamp with time zone,
  CONSTRAINT estimates_pkey PRIMARY KEY (id),
  CONSTRAINT estimates_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id)
);
CREATE TABLE public.email_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  installer_group_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider = ANY (ARRAY['outlook'::text, 'gmail'::text])),
  email text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  id_token text,
  scope text,
  token_type text NOT NULL DEFAULT 'Bearer'::text,
  expires_at timestamp with time zone NOT NULL,
  ext_expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT email_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT email_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT email_accounts_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id)
);
CREATE TABLE public.lead_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  source text NOT NULL DEFAULT 'note'::text,
  note_id uuid,
  CONSTRAINT lead_notes_pkey PRIMARY KEY (id),
  CONSTRAINT lead_notes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT lead_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT lead_notes_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.lead_notes(id)
);
CREATE TABLE public.lead_note_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL,
  user_id uuid,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'note'::text,
  CONSTRAINT lead_note_tags_pkey PRIMARY KEY (id),
  CONSTRAINT lead_note_tags_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.lead_notes(id),
  CONSTRAINT lead_note_tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.work_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category text NOT NULL,
  name text NOT NULL,
  cost_per numeric DEFAULT '0'::numeric,
  markup_percent numeric DEFAULT '0'::numeric,
  installer_group_id uuid NOT NULL,
  CONSTRAINT work_items_pkey PRIMARY KEY (id),
  CONSTRAINT work_items_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id)
);
CREATE TABLE public.suppliers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  index numeric,
  CONSTRAINT suppliers_pkey PRIMARY KEY (id)
);
CREATE TABLE public.products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  category_id uuid NOT NULL,
  subcategory_id uuid,
  name text NOT NULL,
  price_ex_vat numeric NOT NULL DEFAULT '0'::numeric,
  attachment text,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT products_pkey PRIMARY KEY (id),
  CONSTRAINT products_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id),
  CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id),
  CONSTRAINT products_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.product_subcategories(id)
);
CREATE TABLE public.product_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  index numeric,
  CONSTRAINT product_categories_pkey PRIMARY KEY (id)
);
CREATE TABLE public.product_subcategories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL,
  name text NOT NULL,
  index numeric,
  CONSTRAINT product_subcategories_pkey PRIMARY KEY (id),
  CONSTRAINT product_subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id)
);
CREATE TABLE public.supplier_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  markup_percentage numeric NOT NULL DEFAULT '0'::numeric,
  installer_group_id uuid DEFAULT gen_random_uuid(),
  CONSTRAINT supplier_categories_pkey PRIMARY KEY (id)
);
CREATE TABLE public.roof_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  PRIS numeric NOT NULL DEFAULT '0'::numeric,
  CONSTRAINT roof_types_pkey PRIMARY KEY (id)
);
CREATE TABLE public.mount_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  roof_type_id uuid NOT NULL,
  product_id uuid,
  price_per numeric NOT NULL DEFAULT '1500'::numeric,
  installer_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id uuid,
  CONSTRAINT mount_items_pkey PRIMARY KEY (id),
  CONSTRAINT mounting_items_roof_type_id_fkey FOREIGN KEY (roof_type_id) REFERENCES public.roof_types(id),
  CONSTRAINT mounting_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id),
  CONSTRAINT mount_items_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id),
  CONSTRAINT mount_items_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id)
);
CREATE TABLE public.email_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  installer_group_id uuid,
  lead_id uuid,
  message_id text NOT NULL UNIQUE,
  conversation_id text,
  subject text,
  from_address text,
  to_addresses ARRAY,
  body text,
  body_preview text,
  received_at timestamp with time zone,
  has_attachments boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  cc_addresses ARRAY,
  CONSTRAINT email_messages_pkey PRIMARY KEY (id),
  CONSTRAINT email_messages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT email_messages_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id)
);
CREATE TABLE public.mount_volume_reduction (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  amount numeric NOT NULL DEFAULT '0'::numeric,
  reduction numeric NOT NULL DEFAULT '0'::numeric,
  amount2 numeric NOT NULL DEFAULT '0'::numeric,
  installer_group_id uuid NOT NULL,
  number numeric DEFAULT '1'::numeric,
  CONSTRAINT mount_volume_reduction_pkey PRIMARY KEY (id),
  CONSTRAINT mounting_volume_reduction_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id)
);
CREATE TABLE public.electrical_installation_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  CONSTRAINT electrical_installation_categories_pkey PRIMARY KEY (id)
);
CREATE TABLE public.electrical_installation_items (
  installer_group_id uuid NOT NULL,
  category_id uuid NOT NULL,
  name text NOT NULL,
  price_per numeric NOT NULL DEFAULT '0'::numeric,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  extra_costs numeric NOT NULL DEFAULT '0'::numeric,
  CONSTRAINT electrical_installation_items_pkey PRIMARY KEY (id),
  CONSTRAINT electrician_installation_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.electrical_installation_categories(id),
  CONSTRAINT electrical_installation_items_installer_group_id_fkey FOREIGN KEY (installer_group_id) REFERENCES public.installer_groups(id)
);
CREATE TABLE public.team_commission (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  amount numeric NOT NULL DEFAULT '0'::numeric,
  amount2 numeric DEFAULT '0'::numeric,
  commission numeric NOT NULL DEFAULT '0'::numeric,
  index numeric,
  team_id uuid NOT NULL,
  CONSTRAINT team_commission_pkey PRIMARY KEY (id),
  CONSTRAINT soleklart_commission_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id)
);
CREATE TABLE public.lead_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  due_date timestamp with time zone,
  title text,
  assigned_to uuid,
  description text,
  lead_id uuid,
  CONSTRAINT lead_tasks_pkey PRIMARY KEY (id),
  CONSTRAINT lead_tasks_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id),
  CONSTRAINT lead_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id)
);
CREATE TABLE public.lead_tasks_comments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  lead_task_id uuid NOT NULL,
  description text,
  CONSTRAINT lead_tasks_comments_pkey PRIMARY KEY (id),
  CONSTRAINT lead_tasks_comments_lead_task_id_fkey FOREIGN KEY (lead_task_id) REFERENCES public.lead_tasks(id)
);
CREATE TABLE public.email_attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email_message_id uuid NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_type text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT email_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT email_attachments_email_message_id_fkey FOREIGN KEY (email_message_id) REFERENCES public.email_messages(id)
);
CREATE TABLE public.lead_note_attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_type text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT lead_note_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT lead_note_attachments_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.lead_notes(id)
);
CREATE TABLE public.solarpanels (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  NAVN text NOT NULL DEFAULT 'panel'::text,
  0-72 numeric NOT NULL DEFAULT '0'::numeric,
  WATTAGE numeric NOT NULL DEFAULT '1'::numeric,
  72-150 numeric NOT NULL DEFAULT '0'::numeric,
  150-300 numeric NOT NULL DEFAULT '0'::numeric,
  300-600 numeric NOT NULL DEFAULT '0'::numeric,
  600-1000 numeric NOT NULL DEFAULT '0'::numeric,
  1000+ numeric NOT NULL DEFAULT '0'::numeric,
  description text,
  CONSTRAINT solarpanels_pkey PRIMARY KEY (id)
);
CREATE TABLE public.commissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  0-72 numeric NOT NULL DEFAULT '1'::numeric,
  72-150 numeric NOT NULL DEFAULT '1'::numeric,
  150-300 numeric NOT NULL DEFAULT '1'::numeric,
  300-600 numeric NOT NULL DEFAULT '1'::numeric,
  600-1000 numeric NOT NULL DEFAULT '1'::numeric,
  1000+ numeric NOT NULL DEFAULT '1'::numeric,
  CONSTRAINT commissions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.lead_status_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  from_status integer,
  to_status integer NOT NULL,
  changed_at timestamp with time zone NOT NULL DEFAULT now(),
  changed_by uuid,
  CONSTRAINT lead_status_history_pkey PRIMARY KEY (id),
  CONSTRAINT lead_status_history_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id)
);
CREATE TABLE public.mail_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  template_key text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mail_templates_pkey PRIMARY KEY (id),
  CONSTRAINT mail_templates_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id)
);
CREATE TABLE public.cold_call_activity (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  user_id uuid NOT NULL,
  installer_group_id uuid NOT NULL,
  from_status integer,
  to_status integer NOT NULL,
  changed_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cold_call_activity_pkey PRIMARY KEY (id),
  CONSTRAINT cold_call_activity_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id)
);